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
8. The **investigation→trivial-fix collapse rule** — the bounded exception (ADR 0070) that
   lets a `type:investigation` resolving into a trivial fix collapse into one `write-code`
   PR; `write-code` and `triage` cite this one statement.

`plan-epic` writes formats 1, 2, and 4. `review-plan` reads 1 and 2 (they are the
structural floor it validates) and owns the `status:planned → status:triaged` flip that
makes a `plan-epic` child pickable. `write-code` reads 1, 2, and 4 and writes 3 and 4.
`review-code` reads 2 (the acceptance-criteria checklist is its gate) and writes 5
(PASS or FAIL). The `review-*` gates also **write** format 2 — but only its **reviewer-append
surface** (§2): an in-scope specialist finding is appended as a new, provenance-tagged
acceptance criterion, fenced append-only / in-scope-only / ACL-gated / frozen-after-round-K
(ADR 0079). `ship-it` reads the format-5 PASS marker as its go-ahead to merge.

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
real one, never replacing it; see below). These three are the **mandatory** dimensions triage
always sets. There is a fourth, **optional** dimension — `milestone` — that is *not* a label
and not always present; it lives on its own GitHub surface and is documented in §Milestone. The
`status:*` labels are the **pipeline state** an issue sits in — the spine the intake skills key
on. The canonical set:

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

## Milestone — the one *optional* intake dimension

`type:*`, `p*`, and `status:*` are **mandatory** dimensions: every issue carries exactly one of
each, and an issue missing any of them is malformed. **Milestone is the exception** — it is an
**optional** fourth intake dimension that sits alongside the three labels, and **most issues
carry none**. An issue with no milestone is **well-formed by default**; absence is the norm, not
a defect (contrast the `status:*` spine, where a missing label is a triage bug).

This section is the **single source of truth** the three behavioral skills cite for milestone —
`triage` (assigns it), `plan-epic` (children inherit it), and `write-code` (consumes it for
pick-order). It defines what a milestone *is* and the mechanical surface it lives on; the
per-skill *behavior* (the assign rules, the inherit logic, the pick-order) lives in those three
skills and **cites this section**, so the dimension can't drift across them (epic
[#406](https://github.com/kamp-us/phoenix/issues/406)) — exactly as the rest of this contract is
cited by the labels and markers it defines. The *why* — what a milestone means and how the set is
curated — is ADR
[0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md);
read it for the rationale, this section for the contract.

**What a milestone encodes.** A milestone is **strategic sequencing / campaign grouping** —
"which focused push, in what order" — **not feature breakdown** (ADR 0072 §1). It is a named
bucket of issues (a product surface like *Search* / *Bookmarks*, or a strategic campaign like
*Pipeline hardening*). Feature decomposition is the job of **epics + native sub-issues**; a
milestone is the cross-cutting *commitment* an epic can't be. A GitHub issue is in **at most one**
milestone, which is why a milestone is a commitment and not a tag.

**Two milestone kinds.** *Surface* milestones key off an issue's product surface and are
**mechanical** to assign (a sözlük bug → the sözlük surface milestone). *Strategic* milestones
require **judgment** ("is this broken-vs-missing? pipeline-critical?"). The distinction is why
`triage`'s milestone assignment is human-judgment-shaped for the strategic kind and near-rote for
the surface kind (ADR 0072 §2).

**Existing open milestones only — a skill never creates one.** Assignment targets a milestone
that **already exists and is open**; a skill assigns to one, never **creates** or restructures
the set. Creating/curating milestones is a **roadmap (human / CPO) act**, deliberately *not*
autonomous — fragmenting the set would destroy its single-source-of-truth value, so there is no
autonomous "create-milestones" skill (ADR 0072 §3). A skill that finds no clear match to an
existing open milestone leaves the issue **unmilestoned**; it does not invent a home.

**Freeze-by-absence — deliberate absence is a signal, never missing data.** A deliberately
**unmilestoned** cluster (e.g. a frozen new-product surface — imge / kampus-CLI / künye) is itself
the signal that the work is **parked / deferred** (ADR 0072 §4). So a missing milestone is
**never** "data to be backfilled": a skill must not auto-fill an empty milestone to make an issue
"complete." Absence carries information — treat it as a value, not a gap. This is the inverse of
the mandatory labels: for `status:*` a missing value *is* a defect to fix; for milestone a missing
value is often the intended state.

**Orthogonal to verification and merge.** Milestone is a **backlog/planning** dimension only.
The gates (`review-code` / `review-doc` / `review-skill` / `review-plan`), `ship-it`, and the
control-plane / merge machinery (§CP) **ignore it entirely** — it never gates a verdict, never
blocks or enables a merge, and is not part of any PASS/FAIL contract. Loading milestone onto a
gate would couple unrelated concerns; it influences only *which work gets picked when*
(`write-code` pick-order), nothing on the verify→merge path.

### Who writes it, who reads it

The dimension has a **write side** (skills that put an issue into a milestone) and a **read
side** (a skill that consumes it for ordering). The shared rules are here; the mechanics are in
each skill.

**Write side:**

- **`triage`** assigns a milestone on a **clear surface-match** — keying off the surface it
  already reads to classify — and only then. The guardrails (this section is their source;
  `triage` cites it): assign **only on a clear match**, default to **unmilestoned**, and **never
  force-fit** — a wrong milestone pollutes that milestone's burndown worse than no milestone
  does. Assign to an **existing open** milestone only; **never create** one. Preserve the
  freeze-by-absence signal: a deliberately-unmilestoned surface stays unmilestoned.
- **`plan-epic`** **inherits the parent epic's milestone** onto each child it creates (if the
  epic has one). This is mechanical and high-value — it keeps a campaign's burndown complete by
  construction, since a campaign milestone on an epic can only be "done" when its children carry
  it too. If the epic has **no** milestone, the children stay unmilestoned (inheritance never
  invents one).
- **`report` stays milestone-blind.** Like its type-blindness, `report` captures raw intake and
  applies **no** milestone — milestone is a classification/roadmap decision that belongs to
  `triage`, not to capture.

**Read side:**

- **`write-code`** may **bias pick-order toward an active milestone** — either under an explicit
  "work milestone N" invocation (drain that milestone by priority + age), or as a default lean
  toward an active campaign. **`p0` stays sovereign**: a milestone bias is a *within-priority-
  bucket* tiebreaker or an *explicit-invocation* scope only — it can **never** starve a `p0`
  outside the milestone. Focus must not silently de-prioritize an emergency; the priority spine
  (§Pipeline labels — all `p0` before any `p1`) wins over any campaign lean.

### The REST surface — the one mechanical reference

Milestone is the issue's native `milestone` field, not a label, so it fits the `gh api` REST path
the whole pipeline already relies on (the org's Projects-classic breaks GraphQL; milestones
sidestep it — ADR 0072, **never GraphQL**). Every skill that reads, writes, or inherits it shares
**this** one mechanical reference:

- **The issue's `milestone` field** — `gh api repos/$REPO/issues/<N> --jq '.milestone.number // "none"'`
  reads it (`none` is a first-class, correct answer, never a defect to repair);
  `gh api -X PATCH repos/$REPO/issues/<N> -f milestone=<n>` assigns it by **numeric milestone id,
  never the title**; `-F milestone=null` clears it.
- **The milestone catalog** — `gh api "repos/$REPO/milestones?state=open"` lists the existing
  open milestones a skill may assign to (the *only* legal assignment targets; a skill never
  `POST`s a new one).
- **The filter** — `gh api "repos/$REPO/issues?milestone=<n>&state=open"` selects the issues in a
  milestone (the read `write-code`'s pick-order / drain-this-milestone query and a campaign sweep
  share).

```bash
# read an issue's milestone (none ⇒ the well-formed default, never a defect to repair)
gh api repos/$REPO/issues/<N> --jq '.milestone.number // "none"'
# the existing open milestones — the ONLY legal assignment targets (never create one)
gh api "repos/$REPO/milestones?state=open&per_page=100" --jq '.[] | "#\(.number)\t\(.title)"'
# assign to an existing open milestone (triage / plan-epic inherit) — numeric id, never the title
gh api -X PATCH repos/$REPO/issues/<N> -f milestone=<milestone-number>
# clear a milestone (rare; assignment is the common write)
gh api -X PATCH repos/$REPO/issues/<N> -F milestone=null
# filter issues by milestone (write-code's drain-this-milestone query, a campaign sweep)
gh api "repos/$REPO/issues?state=open&milestone=<milestone-number>&per_page=100"
```

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

### The reviewer-append surface — a gate may add an AC, fenced four ways (ADR 0079)

The AC list is **seeded** by `triage`/`plan-epic` at intake, but it is **not owned** by them
for the issue's whole life. A `review-*` gate that spots a real, in-scope defect the issue's
AC never named MAY **append a new acceptance criterion** to the linked issue's `### Acceptance
criteria` list, routing the finding into the single converging work-list the loop already
drains — instead of letting an in-scope omission sail through a green gate. The next
`write-code` repair round fixes the appended criterion like any other `[FAIL]` row, and the
next review verifies it. This is the **single source** of the append surface, its tag, and its
fences — every gate and worker cites *this* definition; none re-derives it. See ADR
[0079](https://github.com/kamp-us/phoenix/blob/main/.decisions/0079-reviewer-authored-acceptance-criteria.md).

**The append shape — no new parser.** An appended criterion is written in the **exact
checkbox-bullet shape** the existing list uses, with a trailing **provenance tag**, so
`write-code` and `review-code` read it with no parser change:

```markdown
- [ ] <criterion — observable, checkable from the outside> <!-- ac:review-code pr:#NNN round:K -->
```

The provenance tag is an HTML comment so it renders invisibly yet stays machine-legible. Its
fields are load-bearing:

- **`ac:<gate>`** — the authoring gate (`review-code` / `review-doc` / `review-skill` /
  `review-plan`), making **review-authored vs triage/plan-epic-authored distinguishable from
  the criterion text alone** — a criterion with no `ac:` tag (or `ac:triage` / `ac:plan-epic`)
  is upstream-authored; an `ac:review-*` tag marks the reviewer-append path.
- **`pr:#NNN`** — the originating PR the finding was raised against.
- **`round:K`** — the repair round (the `write-code` round-cluster index, §5/Bounding) it was
  appended in, so the **frozen-after-round-K** fence is recoverable from the tag itself.

The gate + originating PR + round are thus all reconstructable from the tag, keeping the two
authoring paths auditable when the AC list is time-varying within a PR's lifecycle. A
triage-authored criterion needs no tag (its absence *is* the signal); a tolerant reader treats
a missing tag as upstream-authored.

**The four fences** — contract invariants every consumer **cites, never re-derives**:

1. **Append-only.** A reviewer may **add** a criterion, **never edit or remove** an existing
   one. Removing a criterion weakens the conjunctive gate — the exact catastrophe
   `review-skill`'s gate-invariant-preservation check exists to catch (ADR
   [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md)).
2. **In-scope-only.** An appended criterion **MUST trace to the issue's stated goal/user-story**
   — the same trace-to-stated-goal test `plan-epic` already enforces for story coverage (ADR
   [0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md)).
   A tangential finding goes to [`report`](report/SKILL.md), **never** the AC list; this is what
   keeps the list finite and the bounded repair loop converging.
3. **ACL-gated.** Only a **`write+` reviewer's** appended AC counts — resolved at the GitHub
   ACL, **fails closed**, exactly as ADR
   [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
   gates verdict-marker authority (never a checked-in allowlist). An append from a non-`write+`
   author is not an authoritative criterion.
4. **Frozen after round K.** An AC appended **in or after** `write-code`'s final repair round
   (`K = N = 3`, the existing repair cap — §5/Bounding) **escalates to a human** instead of
   looping again, so append-rate can never outrun fix-rate and the loop still terminates.

This section **defines** the four fences; they are **enforced mechanically at the append site**
by the `review-*` gates' shared
[four-fences-enforced append procedure](review-code/SKILL.md#performing-the-append--the-four-fences-enforced-at-this-site-adr-0079)
(ADR 0079) — fail-closed ACL self-check, round-K freeze-then-escalate, and append-only body
reconstruction — so an invalid append is unrepresentable, not merely discouraged. The drain
side of fence 4 (a frozen `ac:review-*` row escalating instead of looping) is enforced
symmetrically in `write-code`'s repair Bounding.

**The AC contract is time-varying, not fixed at triage.** Because a gate may append mid-life,
the AC list a worker is graded against is **no longer frozen at pickup** — a `write-code` agent
may be measured against a criterion that did not exist when it claimed the issue. This is by
design and **self-corrects within the loop**: the next repair round sees the appended criterion
and drains it (ADR 0079 Consequences). Downstream readers MUST NOT treat the AC list as
immutable; re-read it each round.

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

## CP. The control-plane / blocking set — one canonical definition

Three gates and the merge actor all need to answer the *same* question — **does this PR
touch the control plane?** — and they answered it with **three independently hard-coded
copies** of the path set (`ship-it` Step 0's `grep -Eq`, `review-code`/`review-doc`'s jq
`test(...)`). They agreed by luck, but the set has grown before (ADR 0065 added the
gate-critical skills) and will again — and the #371 → #375 thread *is* that drift story: the
copies were primed to diverge the next time the set changed. This section is the **single
source of the set**, so every consumer cites *one* definition and the copies can't drift
again (ADR [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §6,
closing the #375 drift class).

**The control-plane / blocking set is, exactly:**

- `.claude/**` — the agent control plane (instructions, tools, hooks).
- `.github/**` — CI enforcement.
- the **gate-critical skills** — the verification/merge machinery plus the shared marker
  contract they all depend on:
  - `skills/ship-it/**`
  - `skills/review-code/**`
  - `skills/review-doc/**`
  - `skills/review-skill/**`
  - `skills/review-plan/**`
  - `skills/gh-issue-intake-formats.md` (this file)

A PR touching **any** path in this set is **control plane**: `ship-it` refuses to auto-merge
it and a human merges it by hand (ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md),
widened to the gate-critical skills by ADR
[0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md);
`review-skill/**` added to the gate-critical set by ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md), since the gate
that reviews the gates is itself a gate). Everything else — `apps/web/**`, `packages/**`,
`.decisions/**`, `.patterns/**`, every prose `*.md`, and every **non**-gate-critical
`skills/**` — is **non-blocking** and auto-merges through its matching gate on a PASS.

> **Merge-authority is the only axis this set governs.** It decides *who merges*
> (auto-merge vs. human), **not** *which gate verifies*. Routing is a separate axis: a
> gate-critical skill is **blocking for merge** yet still **`review-skill`-routed for its
> verdict** (ADR 0073 §4). Don't conflate the two — the blocking refusal short-circuits in
> `ship-it` Step 0 *before* the namespace/routing check, so both hold at once.

### The canonical matcher

Every consumer matches the set with this **one** anchored regex (POSIX ERE; the jq/`grep`
form below). Cite this regex; do **not** re-hard-code the path list:

```
^(\.claude|\.github)/|^skills/(ship-it|review-code|review-doc|review-skill|review-plan)/|^skills/gh-issue-intake-formats\.md$
```

```bash
# the single probe ship-it Step 0, review-code Step 2, review-doc Step 0, and review-skill
# Step 0 all use — one definition, no fourth copy:
CONTROL_PLANE_RE='^(\.claude|\.github)/|^skills/(ship-it|review-code|review-doc|review-skill|review-plan)/|^skills/gh-issue-intake-formats\.md$'
gh api "repos/$REPO/pulls/$PR/files?per_page=300" --jq '.[].filename' \
  | grep -Eq "$CONTROL_PLANE_RE" && echo "BLOCKING — control plane (manual merge)"
```

The **0052 instruction-trust set** (root `CLAUDE.md`, `.claude/**`, `.decisions/**`,
`.patterns/**`) is a *different* set — what a reviewer must never *load*, an isolation
concern, not a merge-blocking one. Keep them apart (review-code Step 2 spells out the
distinction). This section governs **only** the merge-blocking / control-plane set above.

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

For a PR in the **control-plane / blocking set** (§CP), `review-doc` is advisory only and
instead leads with the **canonical advisory line** (§6.6 — `review-doc: advisory — blocking-set
PR (manual merge)`) so its verdict stays *out* of `ship-it`'s PASS namespace — a human merges
those (ADR [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)). The advisory line
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
- **Advisory for the blocking set.** A PR in the §CP set gets the canonical advisory line
  (§6.6), not a PASS marker — `review-doc`'s verdict does not authorize that merge; a human
  does (ADR 0053). This keeps the control-plane manual-merge invariant intact.
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on;
  `review-doc` writing it does **not** merge (see review-doc/SKILL.md §"Authority limit").

---

## 6.5. review-skill verdict marker

`review-skill` is the **behavioral-artifact gate** — the third sibling of `review-code`
(§5) and `review-doc` (§6). It gates a **skill PR** (`skills/**`, superseding ADR 0063's
`skills/**` → `review-code` routing) against its linked issue's acceptance criteria *plus*
a skill-specific rigor checklist (behavioral correctness, trigger/`description` quality,
cross-skill conflict/shadowing, gate-invariant preservation — ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §1). It lands its
verdict as a **comment whose first line is a recognizable, SHA-bound marker** — and **only**
that comment, never a native review (like `review-doc`, ADR 0058 rule 4). The marker lives
in its **own namespace**, distinct from §5's `review-code` and §6's `review-doc`.

### Shape — SHA-bound (ADR 0058)

The recognizable **first line** of the PR comment carries the head SHA the reviewer
inspected (`@ <sha>`, from `gh api repos/$REPO/pulls/$PR --jq .head.sha`):

```markdown
review-skill: PASS @ <sha> — merge-ready
```

```markdown
review-skill: FAIL @ <sha> — changes-requested
```

For a PR in the **control-plane / blocking set** (§CP — every gate-critical skill is in it,
so most skill PRs that touch a gate land here), `review-skill` is **advisory only** and
instead leads with the **canonical advisory line** (§6.6):

```markdown
review-skill: advisory — blocking-set PR (manual merge)
```

so its verdict stays *out* of `ship-it`'s PASS namespace — a human merges those (ADR 0053).
The advisory line carries **no `@ <sha>`** by design: it authorizes nothing, so there is
nothing to bind.

The rest of the body carries the per-criterion + per-rigor-check evidence table. What's
load-bearing for the scanner is the namespace, the polarity, **and the `@ <sha>`** — the
same staleness contract as §5/§6: `ship-it`/`write-code`-repair refuse a `review-skill`
verdict whose `@ <sha>` is not the PR's current head, and refuse a SHA-less one (ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), issue #258).

### Comment-only (ADR 0058)

`review-skill` emits its verdict **only** as the SHA-bound `review-skill:` comment, **never**
a native `APPROVE`/`REQUEST_CHANGES` review — for the same reason `review-doc` is comment-only
(§6): a native review cannot carry the `@ <sha>` in the shape this contract controls, so one
comparable record type per lane keeps the lane resolvable.

### Upsert, not append (ADR 0058)

`review-skill` writes **exactly one** `review-skill:` marker comment per PR: before posting
it scans for **its own** prior `review-skill:` marker and `PATCH`es it with the fresh verdict
+ fresh `@ <sha>` rather than appending (ADR 0058 rule 2; same mechanism as §5/§6).

### The matcher contract — anchored, never cross-matching (canonical shape)

`review-skill` adds a **third** namespace to the §5 matcher family, on the same
emphasis-tolerant + SHA-capturing rule. The three matchers are mutually exclusive by
construction — anchored at `^\s*` so a mid-body quote never matches, and each names its
own token so a scan in one namespace can **never** cross-match another:

- code:  `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- doc:   `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- skill: `^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`

A `review-code` or `review-doc` scan must **never** match a `review-skill` marker, and vice
versa. The tokens are distinct literals (`review-code` / `review-doc` / `review-skill`), and
because `review-code:` ends in `code:` while `review-skill:` ends in `skill:`, the anchored
`review-code:` literal cannot prefix-match `review-skill:` — the three are disjoint. Every
matcher site (`ship-it` merge gate, `write-code` fix round-trip, `review-skill` upsert) cites
this one rule so they can't diverge (the same discipline §5 pins for code/doc).

### Field notes

- **Separate namespace.** `ship-it` resolves each gate's verdict in its **own** namespace,
  latest-verdict-wins by timestamp, then the SHA-staleness test (§5/§6). `review-skill`
  never emits a `review-code` or `review-doc` marker, and they never emit a `review-skill` one.
- **First line, recognizable.** The marker leads the comment so a scan matches it without
  parsing the whole body. Recognize it tolerantly by shape (`review-skill: PASS @ <sha>` …
  `merge-ready`) and emphasis (optional leading `**`, §5 matcher contract), not by exact
  dashes — but the `@ <sha>` is required.
- **Two markers, two consumers.** `PASS @ <sha> — merge-ready` (every AC + every rigor check
  verified, bound to that head) is read by `ship-it` as the go-ahead to merge a **non-blocking**
  skill PR **iff `<sha>` is the current head**. `FAIL @ <sha> — changes-requested` (≥1 AC or
  rigor check unmet) is read by `write-code`'s fix round-trip as "my skill PR came back failed";
  `ship-it` reads it as "do not merge."
- **Advisory for the blocking set.** A skill PR touching a gate-critical skill (or any §CP
  path) gets the **canonical advisory line** (§6.6), not a PASS marker — its verdict does not
  authorize that merge; a human does (ADR 0053/0065). This keeps the control-plane manual-merge
  invariant intact, and is exactly the common case for a skill PR (every gate skill is
  gate-critical).
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on;
  `review-skill` writing it does **not** merge (see review-skill/SKILL.md §"Authority limit").

---

## 6.6. The canonical advisory line — one form for all three gates

The three gates once expressed "advisory" two ways: `review-code` emitted a binding
`PASS @ <sha> — merge-ready` line *plus* a control-plane caveat, while `review-doc`
suppressed the binding PASS and led with a **no-`@ <sha>`** advisory line. ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §5 picks
`review-doc`'s form as the **single canonical advisory shape** and converges all three on it.

For a PR in the **control-plane / blocking set** (§CP), the gate emits a comment whose first
line is the **no-`@ <sha>`** advisory marker in its own namespace:

```markdown
review-code:  advisory — blocking-set PR (manual merge)
review-doc:   advisory — blocking-set PR (manual merge)
review-skill: advisory — blocking-set PR (manual merge)
```

The rest of the body carries the same per-check evidence table the PASS/FAIL paths carry —
the verdict is *recorded* (for the human merger to read), it just **authorizes nothing**.
The advisory line **carries no `@ <sha>`** on purpose: it does not enter any `ship-it` PASS
namespace, so there is nothing to bind, and `ship-it` refuses the blocking-set PR regardless
(§CP). A human merges it (ADR 0053/0065).

This is why the advisory form is namespace-uniform but binding-free: it keeps each gate's
verdict **out** of `ship-it`'s merge path for the control plane while still leaving a
visible, evidence-bearing verdict on the PR. (`review-code`'s historical binding-PASS +
caveat shape is the one being retired in favor of this; the reconciliation is part of #424's
build.)

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

## 8. Investigation→trivial-fix collapse — the bounded exception (ADR 0070)

The single source of the collapse rule every skill cites. A `type:investigation` issue
normally settles as a **diagnosis** — `write-code` posts the closing comment, closes
`completed`, and files actionable residue as fresh `report` issues (the residue path, in
`write-code`'s `type:investigation` routing). That contract has one terminal case it does
not serve cleanly: **an investigation whose answer *is* a known, trivial, unambiguous
fix**, which under the letter would have to walk `report → triage → write-code` again —
three hops and three issues for one line. ADR
[0070](https://github.com/kamp-us/phoenix/blob/main/.decisions/0070-investigation-trivial-fix-collapse.md)
closes that seam: such a fix **collapses** into one `write-code` PR.

**The rule.** When a `type:investigation` issue resolves into a fix, `write-code` MAY
implement it and open a PR with `Fixes #N` in the **same run** — *if and only if* the fix
clears **every** bound below. The four bounds are a **hard, AND-ed gate**: if the fix fails
**any one** of them, `write-code` falls back to the diagnosis-and-`report`-residue path
(the status quo). The gate is mechanical, not taste:

1. **Single concern, narrowly scoped.** One logical change in a small, reviewable diff (the
   diagnosis already localized it to one site). Many files or many concerns → residue.
2. **No new behavior, no new surface.** No new public API, route, config key, binding,
   schema/migration, or dependency — the fix restores or corrects *existing* behavior the
   investigation proved wrong.
3. **No contract / control-plane change.** The fix does not touch a path in the
   **control-plane / blocking set** (§CP — `.claude/**`, `.github/**`, or a gate-critical
   skill; ADRs
   [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)
   / [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md)).
   Anything control-plane is never a collapse — it takes the full path and a human merge.
4. **Cause is established, fix is unambiguous.** The diagnosis names the root cause and the
   fix follows directly from it, with no remaining design choice. A fix that opens a design
   question is not trivial — record/route it, don't collapse.

**The collapse is explicit, not silent.** The PR body states it is a collapsed
investigation, links the issue, and carries the diagnosis (the verdict the closing comment
would otherwise have held) so `review-code` can verify the fix against the named cause as
its acceptance criterion. **Verification is not collapsed** — the PR is independently gated
by `review-code` exactly like any other PR; only the *intake* hops (`report → triage`) are
skipped. Residue that does **not** clear the bound is still filed as fresh `report` issues,
unchanged.

**Where the rule lives.** This path is **owned by `write-code`** — the cause is discovered
there, the agent holds the context, and keeping the rule there avoids the cross-stage
ping-pong of routing the re-type through `triage` (ADR 0070 rejected that option). So:

- `write-code`'s `type:investigation` routing carries the **collapse branch** (the
  AND-ed gate above, with the residue fallback) and cross-references this section.
- `triage` **does not** gain an investigation-re-type step — the investigation stays
  `type:investigation` and the collapse happens at `write-code`. `triage`'s
  `type:investigation` classification cross-references this section so the boundary is
  visible at classification time, but adds no re-type behavior.

---

## Relationship between the formats

| Format | Lives on | Written by | Read by |
|---|---|---|---|
| `## Dependencies` grammar | epic body | plan-epic | review-plan, write-code |
| Sub-issue body | each sub-issue | plan-epic | review-plan, write-code, review-code |
| Sub-issue AC — reviewer-append surface (§2) | each sub-issue's `### Acceptance criteria` | review-code, review-doc, review-skill, review-plan (append-only, ACL-gated, ADR 0079) | write-code (drains), review-* (verifies) |
| Progress comment | the worked issue | write-code | write-code (successor) |
| Epic handoff note | parent epic | write-code | write-code (siblings) |
| review-code PASS marker | the PR | review-code | ship-it |
| review-code FAIL marker | the PR | review-code | write-code (fix round-trip) |
| review-doc PASS marker | the PR | review-doc | ship-it |
| review-doc FAIL marker | the PR | review-doc | write-code (fix round-trip) |
| review-skill PASS marker | the PR | review-skill | ship-it |
| review-skill FAIL marker | the PR | review-skill | write-code (fix round-trip) |
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
≥ 1-criterion invariant guarantees there is always something to check. The list
is **seeded** at triage but **time-varying within a PR's lifecycle** — a `review-*`
gate may append an in-scope, provenance-tagged criterion through the fenced
reviewer-append surface (§2, ADR 0079), so readers re-read it each round rather
than treating it as fixed at pickup.
