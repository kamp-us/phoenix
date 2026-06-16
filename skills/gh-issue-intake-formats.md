# GH Issue Intake — formats contract

The single shared contract the issue-intake skills cite. It defines the shared
formats and protocols that turn GitHub issues, comments, and sub-issues into an
agent-operable work pipeline:

1. The epic-body **`## Dependencies` grammar** — how an epic encodes its
   workflow topology (sequential phases, parallel groups, gating edges).
2. The **sub-issue body format** — one executable task, mirroring a task entry.
3. The **progress-comment format** — a per-issue work-log entry for the next agent.
4. The **epic handoff-note format** — distilled cross-task context posted to the epic.
5. The **review-code verdict markers** — the recognizable first line of a PR comment
   signalling the verdict, **SHA-bound** to the head it reviewed (ADR 0058):
   `PASS @ <sha> — merge-ready` (read by `ship-it`, the merge step) or
   `FAIL @ <sha> — not merge-ready` (read by `write-code`'s fix round-trip).
6. The **review-doc verdict markers** — the doc-class twin of format 5, in its own namespace.
7. The **issue-claim semantics** — self-assign as a detect-and-tiebreak (not a lock), the
   protocol `write-code`'s pick (Step 1) and claim (Step 3) implement.

`plan-epic` writes formats 1, 2, and 4. `review-plan` reads 1 and 2 (they are the
structural floor it validates) and owns the `status:planned → status:triaged` flip that
makes a `plan-epic` child pickable. `write-code` reads 1, 2, and 4 and writes 3 and 4.
`review-code` reads 2 (the acceptance-criteria checklist is its gate) and writes 5
(PASS or FAIL). `ship-it` reads the format-5 PASS marker as its go-ahead to merge.

The full pipeline order is `report` → `triage` → `plan-epic` → `review-plan` →
`write-code` → `review-code` → `ship-it`: `review-plan` is the deterministic gate between
`plan-epic` and `write-code` (the plan-layer twin of `review-code`'s PR-layer gate), so an
epic child is only pickable once `review-plan` has flipped it — see §Pipeline labels and
ADR [0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md).

## Reading stance: convention, not parser spec

Every reader and writer of these formats is an LLM, not a regex. These grammars
are **conventions that make intent legible**, not a serialization a parser must
round-trip. Read them tolerantly:

- Recognize a section by its heading and shape, not by exact whitespace,
  punctuation, or attribute order.
- If a writer used a synonym, a slightly different bullet style, or added an
  extra field, infer the meaning rather than failing.
- Never reject an issue or block work because a format "didn't parse." If
  something is genuinely ambiguous, resolve it with judgment and note the
  assumption in a progress comment.

Conversely, when **writing**, follow the canonical shape below so the next
reader has the easiest possible job. Tolerant reading is not licence for sloppy
writing — it's the safety margin, not the target.

---

## Target repo resolution

The suite is a **repo-agnostic** installable plugin: an adopter installs it into
their own repo and the pipeline operates on *their* issues (epic #228, ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)).
So a skill must never hardcode `kamp-us/phoenix` in its `gh api` calls — it resolves
the target `owner/name` once, at the top of its run, and uses it everywhere.

**The one resolution snippet every parameterized skill uses:**

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

The target `$REPO` resolves, in order:

1. **`$CLAUDE_PIPELINE_REPO`** if set (format `owner/name`) — the explicit override, for
   fork workflows or when the working dir's `origin` is not the target.
2. Otherwise **the current repository**, from
   `gh repo view --json nameWithOwner -q .nameWithOwner` (which reads the `origin` remote).

Every `gh api repos/<owner>/<name>/...` call then becomes `gh api repos/$REPO/...`.

This makes the common case **zero-config**: the pipeline operates on whatever repo you
are working in. In phoenix itself, with `CLAUDE_PIPELINE_REPO` unset, `gh repo view`
resolves to `kamp-us/phoenix`, so the behavior is unchanged with no config — the
documented default. An env var, not a checked-in config file, is the override because a
config file would itself be a per-repo artifact the adopter has to author and keep in
sync, whereas the derivation needs nothing (ADR 0062 §1).

A skill that names a *literal* repo in its frontmatter `description:` (so its trigger
text reads as phoenix-only) is also de-pinned: the trigger describes the *capability*
(processing a GitHub triage queue, picking the next issue), not a specific repo.

> **Carve-outs (ADR 0062 §3/§4).** Two classes of `kamp-us/phoenix` reference are
> **intentionally not** rewritten to `$REPO`: `review-plan`'s `@kampus/epic-ledger`
> invocation (the one acknowledged-pinned piece for v1, §3) and external doc-reference
> URLs rewritten to stable `https://github.com/kamp-us/phoenix/blob/main/...` permalinks
> (§4). Those are separate children's work; only `gh api` literals and trigger-text
> repo names are the de-pin target here.

---

## Pipeline labels

Every issue carries one `type:*`, one `p*`, and one `status:*` (plus, transiently, the
`status:planning` epic-lock on a locked epic — a second `status:*` that sits *alongside* the
real one, never replacing it; see below). The `status:*` labels are the **pipeline state** an
issue sits in — the spine the intake skills key on. The canonical set:

| Label | Meaning | Pickable by `write-code`? |
|---|---|---|
| `status:needs-triage` | Raw intake; not yet classified. Filed by `report`. | No |
| `status:needs-info` | Parked — `triage` needs an answer before it can act. | No |
| `status:planned` | A `plan-epic` child: planned and structurally complete, **not yet verified**. | **No** |
| `status:triaged` | Cleared the gate before it — ready for `write-code` to pick. | **Yes** |

One label on the table is **not** a pipeline state — `status:planning` is a **transient
epic-lock** (below), held on an *epic* while one of `{plan-epic, review-plan}` mutates its
children. It sits *alongside* the epic's real `status:*`, never replacing it, and does not
change what `write-code` picks.

| Label | Meaning | Pickable by `write-code`? |
|---|---|---|
| `status:planning` | **Transient epic-lock** — a `plan-epic`/`review-plan` run is mutating this epic's children; a second mutator backs off. Released to PASS-or-park. Not a pipeline state (ADR [0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md)). | n/a (lock, not state) |

`status:triaged` is the one pickable state. It is reached two ways, and **only** these
two: a standalone issue gets it from `triage` (the human-judgment gate at intake); a
`plan-epic` **child** gets it from `review-plan` (the deterministic gate at the plan
layer — ADR [0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md)). Either way,
`status:triaged` is a **post-gate** state, never the immediate output of `plan-epic`.

### The `planned → triaged` flip

`plan-epic` mints its children **`status:planned`**, *not* `status:triaged` — a planned
child is unpickable by construction (`write-code`'s pick predicate selects only
`status:triaged`). A child becomes pickable only when **`review-plan`** validates the
epic ledger against the deterministic structural floor (an empty hard-defect set) and
flips that one child's `status:planned → status:triaged`. `review-plan` **owns this
flip** and nothing else does it; it is the symmetric twin of `review-code`'s
PR → merge gate, one stage earlier (plan → `write-code`).

This is why the flip *is* the enforcement: because `write-code` already keys on
`status:triaged` and nothing else, an unverified-but-pickable child cannot exist —
`status:planned` makes the unverified state unrepresentable to the picker, with **no
change to `write-code`'s predicate**. See ADR
[0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md) for the full gate architecture.

### The `status:planning` epic-lock — one mutator at a time over an epic's children

`status:planned` (the child label) and `status:planning` (the **epic-lock**) are different
things: the first is a child's pipeline state, the second is a transient lock on the *epic*.

Two stages mutate an epic's children and nothing else serializes them — `review-plan` owns
the `planned → triaged` flip, `plan-epic` owns supersede/unlink/close on re-plan. Run
concurrently on one epic they interleave: a re-plan supersedes child C at the same instant
the gate flips C `triaged` (pickable), and `write-code` picks a dropped story (#264). The
`status:planning` label serializes them:

- A mutator (`plan-epic` on any run; `review-plan` before its gate flip or its first
  `rePlan`) **acquires the lock first** — re-read the epic's labels, and if `status:planning`
  is absent `POST` it; if **present, back off** (don't mutate — another run is planning this
  epic). Hold it to **PASS-or-park**, then `DELETE` it on every exit path (including failure).
- This is **detect-and-serialize, not a mutex** — `POST .../labels` is **not** compare-and-swap
  (no `If-Match`), so two mutators that both read it absent in the same window both acquire
  (the §7 / #260 TOCTOU, one layer up over the whole child set). The lock narrows the window;
  the residual is backstopped by the epic-body **splice + recheck** (§1 "Updating it safely",
  #261) and the convergence loop's signature checkpoint. Don't claim a lock guarantee the label
  API can't give — claim "the common flip-vs-supersede / concurrent-re-plan interleaving is
  serialized." See ADR [0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md).

---

## 1. The `## Dependencies` grammar

An epic body ends with a pinned `## Dependencies` section that encodes the
epic's execution topology over its sub-issues: which children can run in
parallel, and which must wait for others to finish first.

**Topology only.** This section says *what gates what*. It does not carry retry
budgets, concurrency caps, code flags, model selection, or any orchestrator
runtime concern — those belong to whatever loop drives the pipeline, not to the
shared issue state. An epic that names topology and nothing else is correct.

### Vocabulary

- **Phase** — a `### Phase N` heading. Phases run in order: every issue in
  Phase 1 must be closed before any issue in Phase 2 starts. Phases are the
  sequential spine.
- **Parallel group** — the issues listed *within a single phase* have no
  ordering between them. They can be picked and worked concurrently.
- **Gating edge** — an explicit `requires:` annotation on an issue, naming
  other issues that must close before this one is eligible. Use this for a
  dependency that does not fall cleanly on a phase boundary (e.g. a child in a
  later phase that only needs *one* specific earlier child, not the whole prior
  phase). A `requires:` may name an issue **outside this epic** — a legitimate
  cross-epic dependency (e.g. a CLI verb requiring another epic's backend). The
  `review-plan` floor resolves such refs at the GitHub boundary and does **not**
  flag them as `DANGLING_DEP`; only a ref that resolves to no real issue dangles.

Blockedness is **derived, never stored**: an issue is unblocked when its phase
predecessors are closed and every issue named in its `requires:` is closed.
There is no `status:blocked` label — `write-code` recomputes eligibility from
this section on every pick.

### Shape

```markdown
## Dependencies

### Phase 1
- #101 — label schema bootstrap
- #102 — formats contract doc

### Phase 2
- #103 — report skill
- #104 — triage skill (requires: #102)

### Phase 3
- #105 — plan-epic skill (requires: #102, #104)
```

References are GitHub issue numbers (`#NNN`); the trailing text after `—` is a
human-legible label, not load-bearing. A bare phase list with no `requires:`
lines is the common case — most topology is just "this phase, then that phase."

### Worked example (parallel group + sequential gate)

A four-child epic where Phase 1 has two children that run **in parallel**, and
Phase 2 has a child that is **sequentially gated** behind a specific Phase-1
child rather than the whole phase:

```markdown
## Dependencies

### Phase 1
- #210 — define the wire schema
- #211 — write the migration script

### Phase 2
- #212 — implement the encoder (requires: #210)
- #213 — end-to-end smoke test
```

Reading this:

- **Parallel group:** `#210` and `#211` are both in Phase 1 with no `requires:`
  between them, so they may be worked simultaneously.
- **Sequential gate:** `#212` carries `requires: #210` — it is eligible only
  once `#210` closes, even though `#211` (its phase-1 sibling) may still be open.
  It does *not* wait on `#211`.
- `#213` is in Phase 2 with no `requires:`, so it waits on **all** of Phase 1
  (the default phase-boundary gate), then runs alongside `#212`.

### Updating it safely — surgical splice + optimistic recheck, never a blind overwrite

The `## Dependencies` block is **load-bearing shared state**: `write-code` reads it to decide
what's pickable, and `plan-epic`/`review-plan`/a re-plan loop can edit the epic body
concurrently. A whole-body `PATCH` reassembled from one writer's in-memory plan silently
**clobbers** a racing edit — a lost update on the topology (a reverted phase, an orphaned
`requires:`) that mis-sequences autonomous work, surfaced by no error (issue #261; same
last-write-wins family as the issue-claim race §7 (issue #260) and the SHA-bound verdict
contract, ADR 0058 (issue #258)).

So `plan-epic`'s body write is a **guarded read-modify-write**, not a blind overwrite (see
plan-epic/SKILL.md Step 5):

- **Surgical splice (collision avoidance).** Re-read the *live* body immediately before writing,
  replace **only** the `## Dependencies` block (and, on re-plan, the `## Plan (plan-epic)` block),
  and preserve every other byte verbatim — so a concurrent edit to a *different* part of the body
  (the brief, a handoff note) cannot collide at all.
- **Optimistic recheck (abort+retry).** GitHub's issue `PATCH` honors **no** `If-Match` — there
  is no native compare-and-swap — so before the write, re-GET the epic's `updated_at` and compare
  it to the value read at the start; if it moved, **abort, re-read, re-derive the section off the
  fresh body, and retry** rather than overwrite a body you didn't just read.

This is a **window-narrowing detect-and-retry, not a lock** (the same honest framing as §7): it
removes the *silent* lost-update of the topology, but a writer that edits between the recheck and
the `PATCH` is still last-write-wins, and a post-write re-read is the after-the-fact catch. True
single-writer safety on one epic would need a designated single planner or a CAS the API doesn't
offer — don't claim a "lock," claim "no silent lost-update of the topology."

---

## 2. Sub-issue body format

A sub-issue is one executable task. Its body mirrors a task entry: enough for a
`write-code` agent to pick it up cold and know exactly what "done" means.

### Shape

```markdown
**Stories:** <story numbers from the epic's `### User stories` this task implements or unblocks>
**TDD:** yes | no

### What to build
<One or two paragraphs. Concrete scope: what changes, where, and why. Name the
modules/files when known. State explicitly what is *out* of scope if there's a
tempting adjacent thing not to do.>

### Acceptance criteria
- [ ] <criterion 1 — observable, checkable without reading the implementer's mind>
- [ ] <criterion 2>
- [ ] <criterion N>
```

### Field notes

- **Stories** — **required** back-references to the originating epic's `### User stories`
  section (by number). A child names the stories it implements, or — for a
  `type:decision`/`type:investigation`/pure-infra child — the stories it unblocks. This is
  one half of plan-epic's **story-coverage invariant**: every story is covered by ≥ 1 child,
  and every child traces to ≥ 1 story. The rare child that genuinely serves no single story
  (pure infra) carries the explicit marker `none (pure infra — see What to build)` and
  justifies itself there — the line is never silently left blank. See ADR
  [0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md).
- **TDD** — `yes` means the task is test-first (a behavior with a verifiable
  contract); `no` means config, docs, scaffolding, or an operational step where
  test-first doesn't apply. The flag is advice to `write-code`, not a gate; plan-epic sets
  it from the epic plan's testing strategy.
- **What to build** — the spec. Prose, not a checklist. Acceptance criteria say
  *whether* it's done; this section says *what to do*.

### Invariant: at least one acceptance criterion

**Every sub-issue body MUST contain at least one acceptance criterion.** A task
with zero acceptance criteria is malformed — there is no way for `write-code` to
know when to stop or for `review-code` to verify it. If you cannot state a
single checkable criterion, the task is not yet specified well enough to file;
sharpen it until you can, or fold it into a sibling that is. This is the hard
floor: **≥ 1 acceptance criterion, always.**

The checklist is the contract `review-code` verifies one box at a time before a
PR may merge. Write each criterion so a separate agent with no attachment to the
implementation can confirm or deny it from the outside.

---

## 3. Progress-comment format

While working an issue, an agent logs progress as **comments on that issue**.
Each comment is a self-contained work-log entry: what moved, what was decided,
what bit, and what the next agent needs to know. This is the issue-comment port
of a per-task progress log — optimized for the *next* agent's efficiency, not
for narrative.

### Shape

```markdown
**Completed:** <what got done this session — behaviors, files, the commit/PR if any>

**Decisions:** <choices made and why — the ones a reviewer or successor would
otherwise have to reverse-engineer>

**Gotchas:** <traps hit, surprising constraints, things that look wrong but aren't>

**Next:** <what the next agent should do, or what's still open>
```

### Field notes

- Keep it scannable. Bullets over paragraphs. Every line should help the next
  invocation make a faster, better decision.
- Omit a heading if it has nothing under it — an entry that's purely "Completed"
  and "Next" is fine. Don't pad with filler.
- Record decisions at the point of making them, not retroactively. A decision
  buried in a diff is a decision the next agent will re-litigate.
- This is the per-issue ledger. Cross-task context that the *epic* needs goes in
  a handoff note (format 4), not here.

---

## 4. Epic handoff-note format

When an agent **finishes a sub-issue**, it posts a distilled handoff note as a
comment **on the parent epic**. Where the progress comments (format 3) are the
fine-grained ledger on the child issue, the handoff note is the coarse,
cross-task signal the epic needs: what this child produced that *other children
depend on or should know about*. The epic's comment stream becomes the
agent-to-agent relay for the whole workflow.

### Shape

```markdown
### Handoff: #NNN — <child title>

**Done:** <one-line outcome — what now exists/works that didn't before>

**Affects siblings:** <what downstream/parallel children should now assume —
new modules, changed contracts, conventions established, decisions recorded>

**Watch out:** <anything a sibling could trip on — a shared file touched, an
assumption invalidated, a partial state left behind>
```

### Field notes

- Distill, don't dump. The full detail lives in the child issue's progress
  comments and its PR; the handoff note is the *summary a sibling reads instead
  of spelunking the child*.
- "Affects siblings" is the load-bearing field. If finishing this child changed
  what a later phase should do, say so here — that's exactly the context the
  `## Dependencies` graph routes work along.
- If a child completed in pure isolation with zero sibling impact, a one-line
  "Done" handoff is honest and complete. Don't manufacture cross-task context
  that isn't there.

---

## 5. review-code pass marker

When `review-code` lands its verdict and a native review can't be posted (e.g. org
branch rules forbid reviewing your own PR), it falls back to a **comment whose first
line is a recognizable marker**. That marker is a downstream contract: the **`ship-it`**
skill scans PR comments for the PASS marker to find verified, merge-ready PRs
unambiguously, and `write-code`'s fix round-trip scans for the FAIL marker to find a PR
that came back failed.

### Shape — SHA-bound (ADR 0058)

The recognizable **first line** of the PR comment carries the **head SHA the reviewer
inspected** (`@ <sha>`), resolved at post time from
`gh api repos/$REPO/pulls/$PR --jq .head.sha`:

```markdown
review-code: PASS @ <sha> — merge-ready
```

```markdown
review-code: FAIL @ <sha> — not merge-ready
```

`<sha>` is the full or abbreviated (≥7 hex) head SHA. The rest of the comment body carries
the per-criterion evidence table (the verdict). What's load-bearing for the scanner is only
that first marker line — the namespace, the polarity, **and the `@ <sha>`**; the table below
it is for the human and the implementer.

The `@ <sha>` is **load-bearing, not decoration**: `ship-it` and `write-code`-repair refuse a
verdict whose `@ <sha>` does not match the PR's *current* head, and refuse a SHA-less marker
outright — this is what closes the stale-PASS-masks-a-FAIL and head-moved-under-the-verdict
races (ADR [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), issue #258). A marker
with no `@ <sha>` is a *pre-0058 legacy* shape and resolves to `unverified`, not PASS.

### Upsert, not append — one verdict per (PR, gate-namespace) (ADR 0058)

`review-code` writes **exactly one** marker comment per PR in its namespace: before posting
it scans the PR's comments for **its own** prior `review-code:` marker and, if one exists,
`PATCH`es it (`gh api -X PATCH repos/$REPO/issues/comments/<id>`) with the fresh
verdict + fresh `@ <sha>` instead of `POST`-ing a new comment. A re-review of a new head
overwrites the same record; the PR thread never accumulates a stale verdict stream a
millisecond decides. See ADR 0058 rule 2.

### The matcher contract: emphasis-tolerant + SHA-capturing (canonical shape)

The marker line may carry **leading Markdown emphasis** — `review-code` historically emits
it bolded (`**review-code: PASS @ <sha> — merge-ready**`), `review-doc` emits it bare. To stop
the emitter and the matcher from drifting apart (the bolded marker once read as "no verdict"
and stalled every code-lane merge — #219), this contract pins **one** rule both sides cite:

- **Canonical emit shape** (what an emitter SHOULD write): the bare, unbolded first line —
  `review-code: PASS @ <sha> — merge-ready`. New/converging emitters write this.
- **Matcher obligation** (what every scanner MUST accept): an **optional leading `**`** before
  the namespace token, so a bolded marker resolves identically to a bare one, **and a captured
  `@ <sha>`** so the consumer can apply the staleness test. The anchored, case-insensitive
  matcher is `^\s*\**\s*review-(code|doc):\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})` — the leading
  `\**` absorbs the emphasis; `^\s*` still pins it to the start of the body so a mid-body
  *quote* never matches; the trailing `@\s*([0-9a-f]{7,40})` captures the bound head SHA. A
  SHA-less marker that matches only the looser `^\s*\**\s*review-(code|doc):\s*(PASS|FAIL)`
  prefix but **not** the `@ <sha>` tail is a legacy verdict → the consumer treats it as
  `unverified` (ADR 0058 rule 3). Every matcher site — `ship-it` (merge gate) and `write-code`
  (fix round-trip) — cites this rule so they can't diverge again.

### Field notes

- **First line, recognizable.** The marker leads the comment so a scan can match
  it without parsing the whole body. Recognize it tolerantly by shape
  (`review-code: PASS @ <sha>` … `merge-ready`) and emphasis (optional leading `**`, per the
  matcher contract above), not by exact dashes or spacing — but the `@ <sha>` is required.
- **Two markers, two consumers.** `PASS @ <sha> — merge-ready` (every criterion verified,
  bound to that head) is read by `ship-it` as the go-ahead to merge **iff `<sha>` is the
  current head**. `FAIL @ <sha> — not merge-ready` (≥1 criterion unmet) is read by
  `write-code`'s fix round-trip as "my PR came back failed"; `ship-it` reads it as "do not
  merge." Each marker has exactly one merge-relevant meaning.
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on.
  `review-code` writing it does **not** merge; merging is `ship-it`'s deliberate act
  (see review-code/SKILL.md §"Authority limit" and ADR 0048).
- The native approving review (`event=APPROVE`) is the preferred signal when it's
  available; GitHub records its `commit_id`, which **is** the SHA the reviewer approved, so
  `ship-it` applies the same staleness test to a native review via its `commit_id`. This
  marker is the comment-based fallback that carries the same meaning (with the `@ <sha>`
  doing explicitly what `commit_id` does for a native review) where a formal review can't be
  posted.

---

## 6. review-doc verdict marker

`review-doc` is the **doc-class twin of `review-code`** — it gates a doc/knowledge PR
(`.decisions/**`, `.patterns/**`, prose `*.md` outside `.claude/`/`.github/`) against its
linked issue's acceptance criteria *plus* a doc-hygiene checklist. It lands its verdict as a
**comment whose first line is a recognizable, SHA-bound marker** — and **only** that comment,
never a native approving review. The marker lives in its **own namespace**, distinct from
§5's `review-code` marker.

### Shape — SHA-bound (ADR 0058)

The recognizable **first line** of the PR comment carries the head SHA the reviewer inspected
(`@ <sha>`, from `gh api repos/$REPO/pulls/$PR --jq .head.sha`):

```markdown
review-doc: PASS @ <sha> — merge-ready
```

```markdown
review-doc: FAIL @ <sha> — changes-requested
```

For a PR in the **blocking set** (touching `.claude/`/`.github/`), `review-doc` is
advisory only and instead leads with an advisory line (`review-doc: advisory — blocking-set
PR (manual merge)`) so its verdict stays *out* of `ship-it`'s PASS namespace — a human
merges those (ADR [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)). The advisory line
carries **no `@ <sha>`** by design: it authorizes nothing, so there is nothing to bind.

The rest of the body carries the per-criterion + per-hygiene-check evidence table. What's
load-bearing for the scanner is the namespace, the polarity, **and the `@ <sha>`** — the same
staleness contract as §5: `ship-it`/`write-code`-repair refuse a `review-doc` verdict whose
`@ <sha>` is not the PR's current head, and refuse a SHA-less one (ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), issue #258).

### Comment-only — the APPROVE/comment duality is resolved (ADR 0058)

`review-doc` emits its verdict **only** as the SHA-bound `review-doc:` comment, **never** a
native `APPROVE`/`REQUEST_CHANGES` review. This resolves the duality #258 flagged: a native
GitHub review cannot carry the `@ <sha>` in the comment shape this contract controls (it
records `commit_id` in a *different* record type), so leaving `review-doc` free to post either
would force `ship-it` to compare a review against a comment for the doc lane — two
incomparable records. One carrier, the comment, keeps the doc lane resolvable the same way
the code lane is. (`review-code` keeps its native-`APPROVE` path because `ship-it` reads that
review's `commit_id` for the staleness test; `review-doc` does not.)

### Upsert, not append (ADR 0058)

`review-doc` writes **exactly one** `review-doc:` marker comment per PR: before posting it
scans for **its own** prior `review-doc:` marker and `PATCH`es it with the fresh verdict +
fresh `@ <sha>` rather than appending a new comment (ADR 0058 rule 2; same mechanism as §5).

### Field notes

- **Separate namespace from `review-code`.** `ship-it` matches the two markers with two
  anchored, namespaced, emphasis-tolerant, SHA-capturing regexes —
  `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})` and
  `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})` (the matcher contract in §5) —
  resolves latest-verdict-wins **per namespace** by timestamp, then applies the SHA-staleness
  test. A `review-code` scan must never match a `review-doc` marker, nor vice versa.
  `review-doc` therefore **never** emits a `review-code` marker, and `review-code` never emits
  a `review-doc` one.
- **First line, recognizable.** The marker leads the comment so a scan matches it without
  parsing the whole body. Recognize it tolerantly by shape (`review-doc: PASS @ <sha>` …
  `merge-ready`) and emphasis (optional leading `**`, §5 matcher contract), not by exact
  dashes or spacing — but the `@ <sha>` is required.
- **Two markers, two consumers.** `PASS @ <sha> — merge-ready` (every AC + every hygiene check
  verified, bound to that head) is read by `ship-it` as the go-ahead to merge a **non-blocking**
  doc PR **iff `<sha>` is the current head**. `FAIL @ <sha> — changes-requested` (≥1 AC or
  hygiene check unmet) is read by `write-code`'s fix round-trip as "my doc PR came back failed";
  `ship-it` reads it as "do not merge."
- **Advisory for the blocking set.** A PR touching `.claude/`/`.github/` gets the advisory
  line, not a PASS marker — `review-doc`'s verdict does not authorize that merge; a human
  does (ADR 0053). This keeps the control-plane manual-merge invariant intact.
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on;
  `review-doc` writing it does **not** merge (see review-doc/SKILL.md §"Authority limit").

---

## 7. Issue-claim semantics — assignee is a detect-and-tiebreak, not a lock

`write-code` claims an issue by **self-assigning** (Step 3); the picker's "skip assigned
issues" rule (Step 1) reads that claim. This section pins what the claim does and does not
guarantee, so the writer (`write-code` Step 3) and any future reader of an assignee agree.

**Assignee is last-write-wins, not compare-and-swap.** GitHub's `POST
/issues/{N}/assignees` is **additive** — it co-assigns, it does not displace an existing
assignee, and there is no conditional/`If-Match` variant. So a naive read-unassigned →
`POST` self → re-read is a **TOCTOU**, not a lock: two agents that both saw #N unassigned
co-assign `[A, B]` and a best-effort re-read catches only whichever reads after the other's
write (#260). A bare self-assign therefore **cannot** be relied on as mutual exclusion.

**The one atomic signal detects the race; a checkpoint GET resolves it.** The `POST` returns the
full `assignees` array — but only the assignees present **when that POST is processed**, *not* a
snapshot the racers share. So the POST echo is the **detector** (it reveals you may be racing),
not the **resolver**. The claim is made safe by observing your own write, then resolving the
symmetry against canonical issue state:

0. **Defer to a pre-existing owner.** Re-read the assignees just before claiming; if #N is
   already assigned, back off without `POST`ing — a fresh arrival **never evicts an owner that
   was there before it**. This is what stops a late picker that slipped past Step 1 from
   evicting an already-implementing winner.
1. `POST` self as assignee; capture the returned `assignees` list (one observable write — no
   separate best-effort re-read).
2. Compute the **lexicographic-min login** of that list. **This is provisional.** Because the
   echo reflects only the assignees present at *this* POST's processing time, two staggered
   co-racers see **different** sets and **may both** compute themselves as min: if B's POST lands
   first it echoes `[B]` (B thinks it won) and A's later POST echoes `[A, B]` (A thinks it won
   too). The min-login from the echo therefore does **not** decide the race — it only flags a
   candidate. The tiebreak applies **only among co-racers** (agents that read #N unassigned and
   `POST`ed in the same window), never against a prior owner.
3. **The checkpoint GET resolves it.** A provisional winner evicts its co-assignees via `DELETE`,
   then **re-confirms against a fresh read of the issue's current assignees** — a `GET`, *not* the
   step-1 POST echo (the POST echo is exactly the stale snapshot that can show a false win) — that
   it is still `min(assignees)`, aborting and re-picking if not. This GET is **load-bearing for
   ordinary co-racer correctness, not merely a straggler guard**: in the staggered case A (min)
   evicts B, so B's checkpoint GET re-reads `[A]`, sees `min == A != B`, and aborts. Every loser
   **`DELETE`s itself and re-picks** — it does **not** implement, and a co-window claim is
   **never silently co-occupied**.

**What it guarantees vs. what it doesn't.** The full race-case derivation:

- **Staggered co-racers.** Both may pass the provisional `min == me` test off their own echo;
  the checkpoint GET breaks the tie because both re-read the *same* canonical state — exactly one
  finds `min == me`, the other finds it was evicted out of min and aborts. The POST echo detects,
  the GET resolves. Prune the checkpoint as "redundant" and both staggered racers proceed — the
  exact double-pick this section closes.
- **Straggler.** A late agent C that slipped past Step 1 and `POST`s **after** a winner already
  owns #N sees `[winner, C]`. The naive "recompute min, lower login wins" rule is **wrong here**:
  if C sorts below the winner it would evict-and-take while the winner keeps implementing — two
  implementers. Rule 0 prevents it: C, re-reading the assignees and seeing #N already owned
  **before it ever `POST`s**, backs off without self-assigning at all — there is nothing to
  evict and nothing of its own to remove (self-`DELETE` is reserved for the co-racer loser and
  displaced-winner paths, which do `POST` first). Rule 3's checkpoint closes it from the other side: a
  winner somehow displaced catches it at the GET and aborts. Together these make the claim
  **non-revocable from the loser/straggler side** once a winner is established, so "exactly one
  implements" holds against late arrivals too, not only co-window racers.
- **Transient window.** Because `assignees` isn't a CAS, the eviction DELETEs are themselves
  last-write-wins, so the issue may *transiently* show 2 assignees before an eviction lands. The
  picker tolerates exactly this — it skips on **any non-null assignee**, so a transiently
  double-assigned issue is passed over, never double-picked (safe degradation).

So: of any set of co-window racers, exactly one proceeds — deterministically, the rest back off;
no interleaving leaves two past the claim, none backs all of them off (no livelock). It is still
**detect-and-tiebreak, not a kernel mutex**: true single-writer exclusion (no transient
multi-assignment, no after-the-fact eviction) would need a **designated single picker** or a
conditional write the assignee API doesn't offer; this mechanism does not claim that, and the
"it's the lock" framing is wrong — it's the duplicate-implementation race that's closed, by
guaranteeing exactly one implementer.

---

## Relationship between the formats

| Format | Lives on | Written by | Read by |
|---|---|---|---|
| `## Dependencies` grammar | epic body | plan-epic | review-plan, write-code |
| Sub-issue body | each sub-issue | plan-epic | review-plan, write-code, review-code |
| Progress comment | the worked issue | write-code | write-code (successor) |
| Epic handoff note | parent epic | write-code | write-code (siblings) |
| review-code PASS marker | the PR | review-code | ship-it |
| review-code FAIL marker | the PR | review-code | write-code (fix round-trip) |
| review-doc PASS marker | the PR | review-doc | ship-it |
| review-doc FAIL marker | the PR | review-doc | write-code (fix round-trip) |
| issue-claim (assignee) | the issue's assignees | write-code (Step 3 claim), triage (Step 0 sweep-claim) | write-code (Step 1 pick), triage (Step 0 Rule-0 back-off) |

The issue-claim row is the one entry that is a **protocol over the assignee field**, not a
markdown format — §7 governs *how* an agent writes and reads that field (detect-and-tiebreak,
not a lock), so it has no body shape the other rows describe. Two skills use the protocol with
**different claim lifetimes**: `write-code`'s claim is **durable** (it persists across the build
so the picker skips the in-progress issue), while `triage`'s claim is a **sweep-scoped mutex** it
**must release** when the issue reaches its outcome (triage Step 6) — an unreleased triage claim
would leave a `status:triaged` issue non-null-assigned, which `write-code`'s picker skips, making
it triaged-but-unpickable. Same detect-and-tiebreak mechanism, opposite lifetimes.

`review-plan` reads the first two formats as its structural floor (the `## Dependencies`
topology and each sub-issue's acceptance-criteria + `**Stories:**` invariants) and, on a
clean ledger, flips each child `status:planned → status:triaged` — the gate that makes the
child pickable at all (§Pipeline labels, ADR
[0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md)).

The sub-issue's acceptance-criteria checklist (format 2) is the spine of
verification: `review-code` checks every box before merge, and the
≥ 1-criterion invariant guarantees there is always something to check.
