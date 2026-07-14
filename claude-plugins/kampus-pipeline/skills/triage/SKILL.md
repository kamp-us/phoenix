---
name: triage
description: Process the GitHub triage queue — classify, enrich, prioritize, split, or close issues labeled status:needs-triage on the configured target repo. Trigger on "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", "/triage", or whenever you're asked to make the backlog actionable. This is the guardrail between raw intake (the report skill) and pickable work (write-code): nothing reaches a write-code agent without passing through here.
---

# triage

You are the guardrail. Raw issues land in `status:needs-triage` — filed by agents
via the `report` skill, or free-form by humans. Your job is to turn each one into a
single, actionable, correctly-typed, prioritized unit that a `write-code` agent can
pick up cold and trust — or to close it with an audit trail if it can't be salvaged.

You have **full rewrite authority**. Severity and priority are *your* call, not the
reporter's. Splitting a bundle is in your mandate. But you are **salvage-first,
kill-last**: enrich before you close, and never close a human's issue at all.

## The mandate, per issue

For each `status:needs-triage` issue, you produce exactly one of three outcomes:

1. **Triaged** — classified, enriched, prioritized, labeled `status:triaged`. The
   normal path. (A bundle is split first; each resulting unit is triaged.)
2. **Needs-info** — a human-filed issue you can't act on as-is. Labeled
   `status:needs-info` with a comment asking specific questions. **Never closed.**
3. **Closed not-planned** — an unsalvageable *agent*-filed issue. Closed with a
   reason comment and `closed-by-triage`. Last resort, never for human issues.

## All GitHub ops via `gh api` REST — never GraphQL

Every read and write goes through `gh api` — the org's legacy Projects-classic
integration errors out GraphQL issue queries, so this is a hard constraint, not a style
call. Resolve the target repo once, up front (this skill is repo-agnostic — every call
targets `$REPO`); the full resolution rule is the shared contract's **Target repo
resolution** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), ADR 0062 §1),
defaulting to `kamp-us/phoenix` with no config:

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

List the queue:

```bash
gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
  --jq '.[] | "#\(.number) (\(.user.login)) \(.title)"'
```

## The glossary — read `.glossary/`, use the canonical terms

As you classify, enrich, or rewrite a body, reach for the repo-owned vocabulary register
rather than inventing names (the one-concept-named-four-ways drift, #851; ADR 0099):
[`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)
(domain nouns) and [`.glossary/LANGUAGE.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/LANGUAGE.md)
(architecture vocabulary) — the single source; never copy a definition into this skill.

---

## Step 0 — Claim the issue before you mutate it (concurrent-sweep guard)

Triage sweeps run concurrently (the same accounts that file `report` agents also sweep).
Two sweeps that both picked #N off the opening snapshot will **both** rewrite-on-top its
body (Step 4's last-write-wins `PATCH` silently clobbers one enrichment, no error) and
**both** split the same bundle (Step 3, duplicate children). The Step 3 pre-create
re-query guards against a *report agent* twin, **not** against a *sibling sweep* mutating
the same issue in-window. So claim #N before you touch it.

**Claim by self-assigning — the same detect-and-tiebreak `write-code` uses** (Step 3
there; the shared semantics are pinned in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7). Assignee is
last-write-wins, not compare-and-swap, so a bare `POST` self → re-read is a TOCTOU, not a
lock; the protocol below is detect-and-tiebreak, **not** mutual exclusion. Run it
**per issue**, immediately before any mutation (split, rewrite, or label):

```bash
ME=$(gh api user --jq '.login')

# Rule 0 — defer to a pre-existing owner. If #N is already claimed (by a sibling sweep,
# or — see the release note below — by a write-code agent that picked an already-triaged
# issue), back off WITHOUT POSTing and move to the next issue. A fresh arrival never
# evicts an owner that was there before it.
PRE=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
[ -n "$PRE" ] && continue   # already claimed → skip this issue, take the next

# POST self; capture the FULL assignees list the write returns (one observable write).
ASSIGNEES=$(gh api -X POST repos/$REPO/issues/<N>/assignees \
  -f "assignees[]=$ME" --jq '[.assignees[].login] | sort | join(" ")')

# Provisional tiebreak among co-racers: min-login. The POST echo only DETECTS a race
# (staggered co-racers see different sets and both may compute themselves min); the
# checkpoint GET below RESOLVES it. See §7 for the full derivation.
WINNER=$(printf '%s\n' $ASSIGNEES | head -n1)
if [ "$WINNER" = "$ME" ]; then
  for a in $ASSIGNEES; do
    [ "$a" = "$ME" ] && continue
    gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$a"
  done
  # CHECKPOINT — re-read canonical state (a fresh GET, not the stale POST echo) and
  # re-confirm I am still min(assignees). This is what resolves the race; do not prune it.
  STILL=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
  [ "$(printf '%s\n' $STILL | head -n1)" = "$ME" ] || {
    gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"; continue; }
  # claim won and confirmed → triage this issue (Steps 1–6), then RELEASE in Step 6
else
  # lost the tiebreak: self-clean and take the next issue (do NOT triage — do NOT co-occupy)
  gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"
  continue
fi
```

**You MUST release the claim when you finish triaging** (Step 6) — triage's claim is a
*sweep-scoped mutex*, not the durable ownership `write-code`'s claim is. This is the one
place triage's claim differs from `write-code`'s, and it's load-bearing: `write-code`'s
picker (Step 1) **skips any issue with a non-null assignee**, so a triaged issue left
self-assigned by triage would be invisible to every `write-code` agent — triaged but
unpickable forever. Releasing closes that interaction: the issue leaves triage `status:triaged`
**and unassigned**, exactly what the picker expects. (`needs-info` and `closed` outcomes
release too — see Step 6.)

---

## Step 1 — Read the issue and its context

Don't classify from the title. Read the body, then read enough of the codebase to know
what the issue is actually about — the files it names, the ADR/pattern docs it cites, the
related issues. That context is what lets you classify correctly, enrich faithfully, and
pick a real priority; a triage that skips the codebase produces labels nobody downstream
can trust. Note **who filed it** and **what shape it's in** — both feed the human-vs-agent
judgment (Step 5) and the classification (Step 2).

### Intake dedup — is this issue itself a duplicate? (ADR 0181)

You board-read every intake issue anyway, so this is the **zero-new-surface enforcement
point** for the human path: a UI/hand-filed issue never ran `report`'s pre-file dedup check
(the #2802 class), so triage is where a human-filed duplicate is caught. Run the same shared
**intake-dedup tool** the `report` skill uses (ADR 0181), on *this* issue's own title +
keywords, excluding itself so it never flags itself:

```bash
node packages/pipeline-cli/src/bin.ts intake-dedup check \
  --query "<this issue's title + a few distinguishing keywords>" \
  --exclude <N>
```

It prints one `#<n>\t<title>` line per candidate open issue that may already cover this
observation (empty output ⇒ no likely duplicate), fusing the read-after-write `needs-triage`
queue with the eventually-consistent search index — the two sources this skill used to query
by hand. It resolves the target repo itself (ADR 0062 §1), so it needs no `$REPO`.

Read the candidates — it's a search, not an oracle. If one genuinely covers the same thing:

- **Agent-filed duplicate** → it is close-eligible. Fold anything this issue adds into the
  original as a comment, then close this one not-planned as a duplicate via the Step-6 close
  path ([`close-not-planned.md`](./close-not-planned.md) — the duplicate-content-preservation
  step is exactly this case).
- **Human-filed duplicate** → **never auto-closed** (Step 5). Comment linking the original
  (`duplicate of #M`) and apply `status:needs-info`, or triage it normally with a triage-note
  cross-link — the human decides whether to close their own. The dedup surfaces it; it does
  not close it.

An empty result is the common case — proceed to classify.

---

## Step 2 — Classify into exactly ONE of six types

Every issue gets exactly one `type:*`. The boundaries are locked — when an issue
seems to straddle two, the distinguishing question in each definition is the
tiebreaker. Apply the canonical label name (`type:bug`, etc.).

| Type | `type:*` label | Definition — the issue is this when… |
|---|---|---|
| **bug** | `type:bug` | **Behavior diverges from intent.** Something already built does the wrong thing. There's a "supposed to" being violated. |
| **feature** | `type:feature` | **A new capability, directly implementable.** It doesn't exist yet, the path to building it is clear, and it fits in a PR or a few. |
| **chore** | `type:chore` | **No behavior change.** Refactors, renames, dependency bumps, test hygiene, dead-code removal, doc edits. The observable behavior of the system is identical before and after. |
| **decision** | `type:decision` | **One question; the output is a recorded choice.** A fork in the road that needs settling (an ADR), not code. If the deliverable is "we decided X" rather than "we built X", it's a decision. |
| **investigation** | `type:investigation` | **An unknown; the output is knowledge.** Root cause is not yet understood. The deliverable is a diagnosis — *then* maybe a fix, a decision, or a new report. If you can't yet say what to build because you don't yet know what's wrong, it's an investigation. |
| **epic** | `type:epic` | **Too big for one PR; it spawns children.** Multiple questions and/or multiple implementable units under one umbrella. The deliverable is a plan plus sub-issues, not a single change. |

### The boundaries that actually bite

- **decision vs epic** — *one* question → decision; *many* questions, or
  questions-plus-buildable-children → epic. A design issue carrying five open
  questions and a v1 scope is an epic, not a decision.
- **bug vs investigation** — if the wrong behavior is understood and the fix is
  nameable, it's a bug. If you'd have to *investigate* to even say what's wrong (an
  intermittent hang, an unexplained exit code), it's an investigation. "Filed to
  investigate later" in the body is a strong tell. A `type:investigation` whose answer
  *might* turn out to be a trivial fix is **still `type:investigation`** — do **not**
  re-type it to `bug`/`chore` in anticipation. If the diagnosis lands on a trivial,
  bounded fix, `write-code` collapses the investigation into one PR under its
  bounded-collapse branch (the four AND-ed bounds in
  [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §8, ADR
  [0070](https://github.com/kamp-us/phoenix/blob/main/.decisions/0070-investigation-trivial-fix-collapse.md));
  the collapse is owned by `write-code`, not a triage re-type (ADR 0070 rejected the
  re-type path). triage classifies intake and stops there.
- **chore vs feature** — does observable behavior change? Splitting a 1,600-line
  file with identical public surface is a chore. Adding a capability that wasn't
  there is a feature. A dependency bump that *enables* nothing new is a chore.
- **feature vs epic** — can one write-code agent finish it in a PR or two with a
  clear path? Feature. Does it need a plan and sub-issues first? Epic. Judge the
  *real* deliverable, not a shrunken one — **do not invent a "v1 scope" of your own
  to make an issue fit in a PR**; if you have to carve the work down to call it a
  feature, it's an epic and your carve-out is its first child. Tells that you're
  looking at an epic wearing a feature's clothes:
  - **Missing prerequisite infrastructure.** The capability depends on something
    that doesn't exist anywhere yet (an email provider, a moderation backend, a
    scheduled-job mechanism). "Path to building it is clear" is false by definition.
  - **The capability implies new surfaces.** A bookmark needs a saved-items view; a
    report button needs a review surface; a setting needs somewhere its effect shows.
    If acting on the capability requires UI/endpoints nobody has built, count those
    units.
  - **Your own enrichment hedges.** If you catch yourself writing "if this balloons,
    split the X part out" or "Y is explicitly out of scope for v1", that hedge is
    the epic boundary talking — classify accordingly instead of scoping around it.

When genuinely torn, pick the type that best describes the *deliverable* (recorded
choice / knowledge / code / plan-and-children) and note the call in the enrichment.

---

## Step 3 — Split bundled reports

Every open issue must be a **single actionable unit**. If a report bundles two (or
more) genuinely separate problems — two unrelated bugs, a bug plus a refactor, a
question plus a task — split it so each unit can be typed, prioritized, and picked
independently.

How to split:

1. **Decide it's really a bundle.** Two facets of *one* change are not a bundle
   (e.g. "rename the function and update its callers"). Two problems that could be
   worked by different agents at different times, with different types or
   priorities, are.
2. **Re-query before you create.** Report agents run concurrently with your sweep
   (several people run them, from their own accounts), so the queue you listed at
   the start is already stale. Immediately before creating *any* new issue — a
   split child or a follow-up you spotted while triaging — run the same shared
   **intake-dedup tool** (ADR 0181; the one Step 1 and the `report` skill use) on the
   new unit's title + keywords:

   ```bash
   node packages/pipeline-cli/src/bin.ts intake-dedup check \
     --query "<the new unit's title + a few distinguishing keywords>"
   ```

   It fuses the two sources this check always used — the label list is
   read-after-write consistent and catches an issue filed seconds ago; the search
   runs against GitHub's eventually-consistent index but covers older open issues
   that already left the queue. Keyword joining and query shape are the tool's job
   now — you pass free text, not a hand-built `q=` string; it resolves the repo
   itself (ADR 0062 §1), so it needs no `$REPO`.

   If an existing issue already covers it, enrich/triage that one instead of filing
   a twin. (This rule exists because a triage run once filed a duplicate of an issue
   that had landed in the queue minutes earlier.)
3. **Create one new issue per extra unit** via REST, each labeled
   `status:needs-triage` so it re-enters the queue (you'll triage the new ones on a
   later pass — or this same run — like any other). Give each a sharp single-unit
   title and a body that states the one problem, following the report skill's
   5-section shape where it fits (see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)
   for the surrounding format conventions).
4. **Cross-link.** Each new issue references the original (`split from #N`), and you
   add a comment on the original listing the children (`split into #A, #B`). The
   reader can always trace a unit back to where it came from.
5. **Resolve the original.** Either keep it as one of the units (triage it normally,
   having spun the *other* units off) or, if it was purely a container with nothing
   left after splitting, close it not-planned with a `closed-by-triage` reason
   comment pointing at the children (the full close-out protocol — reason comment +
   `closed-by-triage` + `state_reason=not_planned` — is in Step 6). Don't leave an
   empty husk open.

```bash
gh api "repos/$REPO/issues" \
  -f title="<single-unit title>" \
  -f body="$BODY" \
  -f "labels[]=status:needs-triage"
# then cross-link via a comment on the original (Step 6 shows the comment call)
```

---

## Step 4 — Enrich and rewrite (rewrite-on-top, original preserved)

Thin issues become actionable by rewriting them from the codebase context you
gathered in Step 1. The structure is **rewrite on top, original verbatim below**, so
the issue is actionable *without losing provenance*:

```markdown
<your rewritten, enriched body — the actionable version a write-code agent reads first>

---

<details>
<summary>Original report (verbatim)</summary>

<the original body, byte-for-byte unchanged>

</details>
```

What the rewrite adds:

- **Sharper framing.** State the problem in terms of what's actually true in the
  codebase — the real file paths, the function names, the ADR/pattern docs, the
  related issues. Promote anything load-bearing the original buried.
- **Repo-relative paths only — never machine-local paths.** The body is a shared
  artifact, like a committed file: every path in your enrichment must be
  repo-relative (`apps/web/worker/…`, `.decisions/0044-….md`) or a dependency's
  package-internal module, resolvable by anyone who checks out the repo. **Never**
  write a path that only exists on the filer's machine — an absolute path
  (`/Users/…`), a home-dir clone (`~/code/…`, `~/.vault/…`), or a sibling-repo
  source tree. If you grepped a local dependency clone to find a seam, name the
  module by its in-package path, not the clone location. (Same rule the repo
  enforces for committed docs — it just extends to issue bodies and comments.)
- **Acceptance-shaped clarity.** Make "done" legible. For a typed-and-pickable issue
  the write-code agent shouldn't have to reverse-engineer what success looks like. The
  acceptance criteria you author here are the **seed of the list, not a closed set you
  own**: a `review-*` gate may later **append** an in-scope criterion through the
  reviewer-append surface ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)
  §2, ADR [0079](https://github.com/kamp-us/phoenix/blob/main/.decisions/0079-reviewer-authored-acceptance-criteria.md)). Write
  each criterion in §2's checkbox-bullet shape; your criteria are the **un-tagged upstream
  baseline** — a triage-authored criterion needs no provenance tag, its absence *is* the
  signal it's upstream-authored, against which a later `ac:review-*` append stays auditable.
  §2 is the single source of the tag and its fences — cite it, don't restate them here.
- **No invention.** Enrich from what you *found*, not what you wish were true. If the
  original is uncertain, keep the uncertainty — don't manufacture a false plan. Mark
  your additions as triage's read where it helps ("Triage note: …"). Scope-shrinking
  is invention too: don't write a reduced "v1 scope" into the body to make an epic
  look feature-sized (see the feature-vs-epic tells in Step 2) — scoping decisions
  belong to `plan-epic` and the owner, not triage.

Preserve the original **exactly** in the `<details>` block — it's the provenance
record and the reporter's unedited words. If the body has its own triple-backtick
code fences, the `<details>` block still nests them fine; don't re-indent or reflow
the original.

**But the leak invariant outranks verbatim-fidelity when the verbatim content is itself a
leak.** The no-machine-local-paths rule above governs the *whole* body — the enrichment you
write **and** the original you preserve. "Preserve byte-for-byte" fails *toward* exposure when
the original itself contains a machine-local path (a `/var/folders/…<user-hash>…` temp path, a
home path, an absolute `/Users/…`): a naive verbatim re-emit re-commits that leak into a public
issue (the #2393-class violation; the concrete re-leak was #3019). So **before** the original
goes into the `<details>` block, run it through the shared `pipeline-cli` leak matcher and
**redact** any matched local path — REDACT, not strip: the redaction preserves evidential shape
(`@/var/folders/<redacted>` still documents "a temp path was posted as the whole body") while
removing the identifying segments (user-hash, temp filename, home path). This reuses the existing
leak matcher (`findCommentLeaks`, `packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts`) via
the `redact-leaks` tool — it is **not** a second, divergent leak-pattern definition. A leak-free
original is passed through byte-for-byte unchanged, exactly as before.

To get the original and redact any leak before preserving it:

```bash
gh api "repos/$REPO/issues/<N>" --jq '.body' > /tmp/triage-original-<N>.md
# redact any machine-local path leak in the ORIGINAL before it goes into <details>; leak-free
# originals pass through byte-for-byte. Reuses the shared leak matcher — no divergent patterns.
pipeline-cli redact-leaks --body-file /tmp/triage-original-<N>.md > /tmp/triage-original-<N>.redacted.md
# assemble the <details> block from the REDACTED original, never the raw one
```

Assemble the new body in a temp file and read it into `$BODY` so multi-line markdown,
backticks, and the nested fences survive the shell:

```bash
BODY="$(cat /tmp/triage-body-<N>.md)"
gh api -X PATCH "repos/$REPO/issues/<N>" -f body="$BODY"
```

**Epics are the exception — wrap-in-place, never rewrite-on-top.** An epic's original
content is the *brief*, not superseded noise, and it is `plan-epic`'s input: the plan is
appended *below* it (append-down, not rewrite-on-top — see the formats doc), and
`plan-epic`'s surgical splice preserves it byte-for-byte. So for an epic you **do not**
write an enriched, actionable version on top — that would fork the brief `plan-epic`
reads. What you *may* do (and now should, so a post-triage epic body isn't the one type
that leads with flat, un-collapsed intake prose) is **wrap the preserved original in a
`<details>` in place** — byte-for-byte, with nothing enriched above it. Classify and
prioritize, optionally add a short triage note as a comment, then shape the body as:

```markdown
**Epic — awaiting plan.** `plan-epic` appends `## Plan (plan-epic)` and `## Dependencies` below.

<details>
<summary>Original brief (verbatim)</summary>

<the original body, byte-for-byte unchanged>

</details>
```

The same leak-outranks-fidelity rule applies to this wrap-in-place preserve: run the epic's
original brief through `pipeline-cli redact-leaks` before it goes into the `<details>` block, so
a leak-containing brief can't re-leak. A leak-free brief passes through byte-for-byte — the
common case, and the exact bytes `plan-epic` splices are then unchanged.

This is a *collapse in place*, not the Step-4 rewrite-on-top: nothing sits above the
`<details>` but the one-line typed header (so a pre-plan epic body leads with the epic,
not a bare collapsed element), and the brief inside is verbatim (post-redaction) — so the
exact bytes `plan-epic` splices are unchanged for any leak-free brief. The `<summary>` is the epic variant of the other
types' `Original report (verbatim)` — `Original brief` names an epic's original as its
*brief* (Step 2's tell), the same verbatim-provenance guarantee. (If an epic was filed
truly threadbare, prefer `status:needs-info` over mangling it.)

**Re-typing an issue? Reconcile the BODY, not just a comment.** When you change an
already-typed issue's type (a `decision` re-scoped to `feature`, a `bug` recut as a
`chore`), the body's `## Acceptance criteria` are still written for the *old* type — and
the body, not a comment, is the source of truth a `review-*` gate and a `write-code` agent
read. A re-type that lands the new scope in a **comment** while leaving the stale
criteria in the body ships a misleading spec: the coder builds against decision-era ACs
("record an ADR", "file follow-ups") that no longer describe the work (#2165 →
#2180). So on any re-type, **rewrite the body's acceptance criteria to the new type**
(reusing Step 4's temp-file `PATCH` flow), then record the re-scope rationale in a
comment — the comment explains *why*, the body carries *what to build*.

---

## Step 5 — The human-vs-agent judgment (who never gets auto-closed)

**Human-filed issues are never auto-closed.** A human capture gets grace; agent noise
gets filtered. This is a judgment call, not a protocol — you recognize a human filer,
you don't parse a flag.

**The account is not the tell — the shape is.** Every collaborator on this repo
(`usirin`, `cansirin`, …) files both ways: as a human in passing, and via `report`
agents running under their own account. So never treat "who filed it" as settling
the question; read the body.

**The filing-provenance signal is the report footer, not authorship (ADR 0159).** The
reliable input is defined once in
[`gh-issue-intake-formats.md` §4.5](../gh-issue-intake-formats.md) — cite it, don't
re-derive it. In short: authorship is unusable (every report-filed issue shows
`author: usirin` via the shared token), so the signal is the `Filed by an agent` footer.
**Footer ABSENT ⇒ hand-typed in the GitHub UI ⇒ human-owned ⇒ PROTECTED (never
auto-close); footer PRESENT ⇒ filed via the report skill (including a human-invoked
`/report`) ⇒ raw INTAKE ⇒ auto-close-ELIGIBLE after confirmation — the confirmation step
IS the guard.** So an autonomous close/kill-sweep keys eligibility on footer presence: a
footer-absent issue is structurally excluded from auto-close, and a footer-present issue
is only closed once its confirmation step passes — never on footer presence alone.

Tells that an issue is **agent-filed** (the only kind you may close):

- **It carries the agent-report fingerprint.** The `report` skill files a
  recognizable shape: the five sections (*What I was doing / What I observed / Why
  it matters / Pointers / Suggested next step*) and a `<sub>Filed by an agent ·
  …</sub>` metadata footer. The literal **`Filed by an agent` marker is the
  invariant** — the footer's session/model/branch fields are best-effort and often
  absent (`footer.sh` silently drops what the environment doesn't expose), so don't
  treat a sparse footer as "fingerprint missing". The clean five-section structure
  backs the marker up.
- **Five sections but no footer is usually pipeline-made** — a triage split child
  (look for `split from #N` in the body or comments) or another skill's filing.
  Judge by provenance, not just shape: a split child traced to an agent-filed
  original is agent-filed.

Tells that an issue is **human-filed**:

- **It reads scrappy and free-form** — a quick thought, a one-liner, a question, an
  inconsistent shape. Humans file in passing; they don't fill in a template.
- **It lacks the agent fingerprint** — no `Filed by an agent` marker, no
  five-section shape, no pipeline provenance.

When in doubt, **treat it as human.** The cost of wrongly closing a human's issue
(they feel ignored) is worse than the cost of wrongly leaving an agent's issue open
(it sits in needs-info, cheap to revisit).

**For a human-filed issue you can't act on as-is:** apply `status:needs-info` (not a
type, not a priority, not triaged) and post a comment asking the *specific* questions
that would unblock triage. Specific, not generic — "Which file? What's the expected
behavior vs what you saw? Is this blocking anything?" beats "please add more detail".
You may still type a human issue if it's already clear; needs-info is only for the
ones you genuinely can't classify or act on yet.

**Needs-info leaves the queue:** remove `status:needs-triage` when you apply
`status:needs-info` (same DELETE call as the triaged path in Step 6). A parked
question must not re-surface in every sweep and queue listing; it re-enters the
queue when whoever answers swaps the labels back (`status:needs-info` →
`status:needs-triage`). It *does* still appear in the keyword-search half of the
pre-filing re-query, since it stays open — that's intentional, don't "fix" the
search command to filter it out: a report agent finding a needs-info twin should
comment there rather than file anew.

---

## Step 6 — Prioritize, label, and close out

### Assign a priority

Every triaged issue gets exactly one of `p0` / `p1` / `p2`. Priority is *your*
judgment, deliberately coarse — it sets write-code's pick order (highest bucket first,
oldest first within a bucket), so it only has to be *directionally* right, not a precise
ranking. Priority is **milestone-relative**, not an absolute urgency score: `p1` means
"serves the active milestone / you'd pull it next," so it stays naturally bounded by the
current arc instead of becoming the catch-all. The **default is `p2`** — most real work
isn't the current focus.

The **active milestone is not a judgment call**: it is the arc pinned by the single
`active` row of [`ROADMAP.md`](../../../../ROADMAP.md)'s `## Arcs` table — the founder-voice
roadmap that projects each arc onto a GitHub milestone (ADR
[0078](https://github.com/kamp-us/phoenix/blob/main/.decisions/0078-product-driven-decisions-by-default.md);
exactly one arc is `active` at a time). Read that row to know what `p1` is bounded to; if
no `## Arcs` row is marked `active`, there is no active milestone and the fallbacks below
apply.

| Priority | Use when… |
|---|---|
| **`p0`** | **Fire only.** Drop-everything: actively breaking something people rely on, blocking other work, a data-loss or security risk, or a release gate. If it's not a genuine emergency, it's not p0 — reserve it so the bucket stays meaningful. |
| **`p1`** | **Serves the active milestone** — the arc pinned by `ROADMAP.md`'s single `active` `## Arcs` row (defined just above). Real, actionable work that belongs to that active arc — you'd pull it next. Milestone-bounded on purpose: p1 is *not* a general "worth doing soon" tier, so a solid issue outside the active arc is **not** p1. If no `## Arcs` row is marked `active`, keep p1 for the small set of things you'd genuinely pick up next; everything else is p2. |
| **`p2`** | **The default.** Real, actionable work that isn't the current focus — most of the backlog. Also nice-to-have, cleanup, "don't forget to reconsider" trackers, low-impact refactors, deferred investigations. Real work, no time pressure to pull it ahead of the active arc. |

Most of a healthy backlog is `p2`, with a bounded `p1` set tracking the active
milestone. When unsure between two buckets, pick the lower one — over-escalation erodes
the signal faster than under-escalation, and an inflated `p1` is exactly what makes the
backlog unsequenceable.

### Apply the labels (triaged path)

The canonical `type:*` / `p*` / `status:*` label set is defined by the label
bootstrap / formats contract ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)) —
triage *applies* labels from that existing set, and must never silently auto-mint an
off-spec label via `POST .../labels`.

A triaged issue carries: the one `type:*`, one `p*`, and `status:triaged`. Remove
`status:needs-triage` so it leaves the queue. Do it in REST calls:

```bash
# add the type, priority, and triaged status
gh api "repos/$REPO/issues/<N>/labels" \
  -f "labels[]=type:chore" -f "labels[]=p2" -f "labels[]=status:triaged"
# remove the needs-triage label — pass the BARE name; gh api encodes the path segment
# (don't pre-encode the colon as %3A, or gh double-encodes it to %253A → spurious 404)
gh api -X DELETE "repos/$REPO/issues/<N>/labels/status:needs-triage"
```

A `404 "Label does not exist"` on that DELETE is harmless **only** in one known case:
the issue never carried `status:needs-triage` to begin with — a pre-bootstrap backlog
issue that predates the label, which you may triage directly by number. In that case
the label is already absent, so the goal (issue out of the queue) is met. Do **not**
blanket-`|| true` the call: a 404 on an issue that *did* carry the label means the
removal silently failed and the issue is still in the needs-triage queue while looking
triaged. So if you're not certain it's the pre-bootstrap case, verify the label is
actually gone after the call rather than swallowing the error:

```bash
gh api "repos/$REPO/issues/<N>" \
  --jq '[.labels[].name] | index("status:needs-triage") // "removed"'
# expect "removed"; anything else means the label is still on the issue — investigate
```

`status:triaged` is an explicit signature only *you* apply — it tells write-code the
issue was actually reviewed. Never let a type label alone stand in for it; a
hand-slapped `type:*` with no triaged status must not look pickable.

### Assign a milestone (optional — only on a clear match)

Milestone is the **one optional intake dimension** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md),
§Milestone). Unlike the three mandatory labels above, **most triaged issues carry no
milestone, and that is the well-formed default** — absence is the norm, not a defect. So
this is an *additive* step: it never blocks, re-routes, or re-prioritizes an issue. You
either find a clear home for it among the existing open milestones, or you leave it
unmilestoned and move on.

**The rules (the contract section is the dimension definition — these are triage's behavior):**

- **Assign only on a clear surface-match; default = unmilestoned.** When in doubt, assign
  nothing. A *wrong* milestone pollutes a burndown worse than a missing one does — an issue
  filed in the wrong campaign is harder to spot than one that's simply absent. **Never
  force-fit.**
- **Existing open milestones only — triage NEVER creates a milestone.** Read the repo's open
  milestones and match against *that* set; if nothing clearly fits, assign nothing. Creating
  or curating the milestone set is a roadmap (human) act, deliberately not autonomous (ADR
  [0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md)
  §3). Do **not** `POST` a new milestone, ever.
- **Preserve freeze-by-absence.** A deliberately-unmilestoned surface — a frozen new-product
  cluster (e.g. kampus-CLI / künye) — stays unmilestoned. A missing milestone there is
  a *signal* that the work is parked, never data to backfill; do not auto-fill it to make the
  issue "complete" (contract §Milestone, ADR 0072 §4).

**Surface vs strategic — how hard the match is.** The contract names two milestone kinds, and
they differ in how much judgment the match takes:

- **Surface milestones** (e.g. Search / Bookmarks / Account / Report) are **mechanical**: key
  off the **product surface you already determined** reading the issue in Step 1 — a sözlük
  bug → the sözlük surface milestone. If a surface milestone exists and open for the issue's
  surface, the match is near-rote.
- **Strategic milestones** (e.g. Broken core loops / Pipeline hardening / Test & CI) need
  **judgment** — "is this broken-vs-missing? pipeline-critical?". Attempt these
  **conservatively**: assign one only when the issue plainly belongs to that campaign, and
  default to none on any doubt.

Read the open milestones, then assign **only on a clear match**:

```bash
# the existing open milestones — the ONLY legal assignment targets (never create one)
gh api "repos/$REPO/milestones?state=open" --jq '.[] | "#\(.number)\t\(.title)"'
# on a clear match only — one single-field, last-write-wins PATCH (benign, #91)
gh api -X PATCH "repos/$REPO/issues/<N>" -f milestone=<n>
# no clear match → assign nothing; an unmilestoned issue is well-formed (do NOT clear-then-set)
```

This step is **out of scope** for: creating milestones, the inherit logic (that is
`plan-epic`'s job for an epic's children), and the pick-order (`write-code` consumes
milestone, it doesn't assign it).

### Close not-planned (kill, last resort, agent issues only)

The third outcome is **rare** — close an issue **only** when it's an *agent-filed* issue
that is genuinely unsalvageable (a duplicate, an observation the code moved past, a
non-actionable note, or noise), and **salvage first**. Because it's off the common
triaged / needs-info path, its full protocol — the duplicate-content-preservation step,
the auditable reason-comment + `closed-by-triage` + `not_planned` close, and the kill-audit
query — lives in a contract you `Read` only once you've decided to close:
[`close-not-planned.md`](./close-not-planned.md). Open it and follow it for any kill (and
for a Step 3 empty-husk close). **Never close a human-filed issue** (Step 5).

### Release the claim (every outcome)

Once the issue has reached its outcome — triaged, needs-info, or closed — **remove your
self-assignment** so the claim doesn't outlive the sweep. This is mandatory on the
triaged path (otherwise the issue is `status:triaged` but unpickable — `write-code`'s
picker skips any non-null assignee, Step 0). Do it on the other two paths as well, for
consistency: a parked `needs-info` issue or a closed one should carry no stray triage
claim. The DELETE is idempotent — a 404 means it was already unassigned, which is fine.

```bash
ME=$(gh api user --jq '.login')
gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME" 2>/dev/null || true
```

(A `closed-by-triage` issue is closed *and* unassigned; a needs-info issue is parked with
`status:needs-info`, no triage claim. Only a triaged issue stays open, and it must be
unassigned to be pickable.)

---

## Running the queue

You can triage one named issue (`triage issue #34`) or sweep the whole queue. When
sweeping:

1. List `status:needs-triage` (the snippet at the top).
2. For each issue, **claim it first (Step 0)** — a concurrent sibling sweep may have
   picked the same issue off the same snapshot, so claim-or-skip before you mutate it. If
   the claim backs off (already claimed), move to the next issue. Then triage the claimed
   issue through Steps 1–6, **releasing the claim** at the end (Step 6, Release the claim).
3. If you split a bundle, the new children re-enter `status:needs-triage` — pick them
   up on the same sweep or a follow-up; they're triaged (claim → Steps 1–6 → release)
   like any other issue.
4. **Re-list the queue before declaring the sweep done.** Report agents file
   concurrently, so issues land mid-sweep and a snapshot-only sweep leaves fresh arrivals
   behind. An issue *claimed* by a sibling sweep still shows `status:needs-triage` (the
   claim is an assignee, not a label), so it reappears here; Step 0's Rule-0 back-off skips
   it until that sweep releases. Loop until the listing has no issue you can claim — every
   *completed* outcome (triaged / needs-info / closed) removes `status:needs-triage`, so
   that is the termination test.
5. Report a short ledger back: per issue, the outcome (type+priority+triaged, plus the
   milestone if one was a clear match / needs-info / closed) in one line each. Don't
   narrate every REST call — the labels, milestone, and comments on the issues are the
   durable record. **The ledger you hand back is a shared artifact — hold it to the same
   privacy rule as issue bodies and comments** (the "Repo-relative paths only — never
   machine-local paths" rule in Step 4): cite **repo-relative paths only** and no PII —
   never a machine-local path (an absolute `/Users/…`, a home-dir clone `~/code/…`, or a
   sibling-repo tree). The guarantee is a property of the agent, not of who dispatches it;
   a caller must never have to re-scrub the summary before relaying it.

### Cadence hygiene sweep — flag 100%-open milestones (flag-only, NEVER auto-close)

Once per sweep, run a **milestone-hygiene pass**: surface every open milestone that has hit
**100% (`open_issues == 0`, `closed_issues > 0`)** to the EA for a close / keep / retire
call. An open milestone is meant to signal *active work*; one sitting at 100% signals
nothing, so the board's focus signal rots. This sweep is the natural home for that hygiene
check — it costs one REST read and keeps the milestone list readable.

**Flag-only — this sweep NEVER modifies or closes a milestone.** It is the exact mirror of
the human-filed-never-auto-closed rule (Step 5): the *disposition* of a completed milestone
is founder judgment, not a mechanical act. A 100%-open milestone may legitimately stay open
(more issues genuinely planned), may be **done → close**, or may be a **bucket masquerading
as a milestone → retire** (convert to a plain label). Per the glossary's **Milestone** term
([`../../../../.glossary/LANGUAGE.md`](../../../../.glossary/LANGUAGE.md)) — *a milestone is an
initiative; an initiative has a Definition of Done; a catch-all with no DoD is a label, not
a milestone* — a fixes-bucket at 100% is retired, not closed-as-done. Deciding which of the
three applies is out of triage's scope (ADR
[0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md)
§3 — curating the milestone set is a roadmap, human act). Triage **flags**; the EA decides.

```bash
# open milestones at 100% — 0 open issues, at least one closed (an empty milestone is not "done")
gh api "repos/$REPO/milestones?state=open&per_page=100" \
  --jq '.[] | select(.open_issues == 0 and .closed_issues > 0)
        | "#\(.number)\t\(.title)\t(\(.closed_issues) closed, 0 open)"'
```

Surface the matches in the sweep ledger (Step 5's report-back) as a **flag to the EA** — one
line per 100%-open milestone with its number, title, and closed count, tagged for a
close/keep/retire call. Do **not** `PATCH`/close a milestone, and do **not** file a follow-up
issue per milestone — the flag in the ledger is the surfacing; the routed board-hygiene action
is the EA's, downstream of this sweep. If the sweep finds no 100%-open milestone, note "none"
and move on — the check is idempotent and read-only.

## Conventions

This skill is one of a suite (`report` → **`triage`** → `plan-epic` → `review-plan` →
`write-code` → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). You consume exactly
the issues the `report` skill files (recognize its 5-section + metadata-footer shape —
Step 5), and you hand `status:triaged` issues off to `plan-epic` (epics) and
`write-code` (everything else — a standalone issue is pickable straight from your gate;
an epic's children become pickable only after `plan-epic` plans them and `review-plan`
flips them `status:planned → status:triaged`).
