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

## Verification-provenance discipline — every gate agent, emitter-side (ADR 0152)

This is a **general agent-contract rule that binds every gate agent** that reads or writes
these formats — the `triager` first, and every `review-*` / `ship-it` / `plan-epic` gate by
extension. It is stated **once here**, on the shared all-gates contract, so no gate agent is
left uncovered by virtue of not being a particular skill; it is **not** scoped to any single
SKILL.md (ADR
[0152](https://github.com/kamp-us/phoenix/blob/main/.decisions/0152-confabulation-guardrail-and-resume-cap.md),
mitigation (a)).

**The rule.** A gate agent **MUST NOT assert a falsifiable platform-state claim or an
action-attribution as *verified* unless it ran the check itself, in its own transcript, this
run.** Any such claim it did **not** run must be surfaced as **unverified** (or dropped) — it
may not be presented as fact. And an action must **never** be attributed to another party (the
orchestrator, a sibling agent, a human) that the emitter did not observe that party perform:
"the orchestrator ran X" / "your evidence chain proves Y" is assertable **only** when the
emitter observed that party do X, even if X happens to be true.

A **falsifiable platform-state claim** is one checkable against the live platform this run — a
ruleset/branch-protection state, a PR's `mergeable_state` or merge-queue membership, a flag's
release state, a label or assignee, whether a named PR/issue exists or merged, a CI conclusion.
Citing any of these *as verified* requires the actual `gh api` / tool call to appear in **this
run's** transcript; an un-run such claim is *unverified*, full stop.

**This is the emitter-side complement of CLAUDE.md's reader-side grounding rule, not a
duplicate of it.** CLAUDE.md's "ground falsifiable claims about platform/runtime/dependency
behavior in source, not intuition" tells the **reader** to re-ground a claim it consumes; this
rule tells the **emitter** it may not launder an un-run claim as *verified* in the first place.
The reader-side backstop is not always run — so the emitter obligation must be explicit. The
two are one loop: the emitter marks provenance honestly, the reader still re-grounds.

**Why it binds a gate specifically.** A gate agent's output becomes issue bodies, labels, and
routing decisions, so a false-but-confident claim in its return channel propagates into the
pipeline. The failure mode this closes is the confabulated evidence chain that *happens to be
right* — which trains the reader to trust the next one (the #1876 near-miss: a long-resumed
triager returned a fabricated platform-verification "evidence chain" as observed fact and
mis-attributed it to the orchestrator, caught only by independent downstream re-grounding).
Marking un-run claims *unverified* costs a gate the transcript action of actually running any
check it wants to cite as verified — deliberately: the price of trustworthy gate output.

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
always sets. There is a fourth dimension — `milestone` — that is *not* a label; it lives on its
own GitHub surface, and triage homes every issue in one unless a standing-lane label or a kill
applies (ADR 0202/0208). It is documented in §Milestone. The
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

### The `wayfinder:map` / `wayfinder:backlog` ideation-layer markers — not pipeline states, not `type:*`

Two labels sit in this table's neighborhood but are **neither a `status:*` pipeline state
nor a `type:*`** — the ideation-layer marker set. **`wayfinder:map`** is an **issue-shape
marker** (epic #2421). It marks an issue as a **wayfinder map** — the ideation-layer front
door that sits *upstream* of this execution pipeline (chart a fuzzy destination, work its open
frontier of investigation/decision tickets, then hand a concrete plan to `triage` /
`plan-epic`). It **reuses the existing issue infrastructure** rather than minting a new
`type:*`, so it ripples no intake floor: the `write-code` pick predicate keys on
`status:triaged` and is untouched by it.

**`wayfinder:backlog`** is its upstream sibling — the **cartographer's backlog**. It marks an
issue as a **destination queued for a wayfinding chart**: a fuzzy end-state named but not yet
charted into a map. Like `wayfinder:map` it reuses the existing issue infrastructure and mints
no new `type:*`, and like it, it is an **ideation-queue marker**, not a buildable status — it
sits one step further upstream still, before charting even begins.

| Label | Meaning | Pickable by `write-code`? |
|---|---|---|
| `wayfinder:map` | **Issue-shape marker** (not a state, not a type) — this issue is a **wayfinder map**: the ideation-layer map whose body carries the four-section map shape (`## Destination` / `## Decisions-so-far` / `## Open frontier` / `## Graduated fog`) the `wayfinder` skill's chart/work modes and the wayfinder CLI read and write. Upstream of the pipeline (#2421). | No (an ideation surface, not pickable execution work) |
| `wayfinder:backlog` | **Ideation-queue marker** (not a state, not a type) — this issue is a **destination queued for a wayfinding chart**: the cartographer's backlog of fuzzy end-states named but not yet charted. Sits upstream of triage, one step further up than `wayfinder:map`. | No (an ideation surface, not pickable execution work) |

The **body shape** a `wayfinder:map` issue carries is defined below in
[§The `wayfinder:map` issue shape](#the-wayfindermap-issue-shape); these rows document only
the labels. Neither is `write-code`-pickable: a `wayfinder:map` issue is worked by the
`wayfinder` skill, and only the concrete work it *graduates* into `triage` / `plan-epic`
becomes pickable execution issues. A `wayfinder:backlog` destination graduates one step
earlier — the cartographer **charts** it into a `wayfinder:map` (which then graduates its
cleared frontier into that emitted factory work), so a charted destination drops
`wayfinder:backlog`; keeping the label after it has been charted violates that discipline.

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

The lock is **two layers**, exactly mirroring the issue-claim of §7 one level up over the
whole child set — a coarse availability label gated by a fine, agent-distinguishable claim
comment (the agent-distinguishable claim marker, ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md), #1452):

- **Coarse availability gate — the `status:planning` label.** A mutator (`plan-epic` on any
  run; `review-plan` before its gate flip or its first `rePlan`) re-reads the epic's labels: if
  `status:planning` is **present, back off** (don't mutate — defer to a holder already there,
  the §7 Rule-0 "a fresh arrival never evicts an owner that was there before it"); if **absent,
  `POST` it**. The label is the cheap, list-visible "is this epic being planned **at all**?"
  signal — but because `POST .../labels` is **additive, not compare-and-swap** (no `If-Match`),
  two runs that both read it absent in the same window both `POST` the same single shared label,
  and under the one shared `usirin` login the label's author cannot tell them apart. So the label
  **alone** says only *whether* the epic is being planned, never *which* run holds the lock — the
  same post-`/labels` TOCTOU that double-planned #1359 (stray child #1403).

- **Fine, agent-distinguishable resolution — the planning-claim comment (ADR 0115).** Right
  after `POST`ing the label, the mutator posts the §7 claim-comment primitive **on the epic** —
  `claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC>`, the emphasis-tolerant marker §7 defines —
  then runs the **same checkpoint-GET resolution** §7 uses: list the epic's comments, keep claim
  markers **authored by a write+ collaborator** (the ADR
  [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
  trust root), and the **earliest authorized claim** — minimum `(created_at, comment id)` — is
  the canonical winner (ADR 0115 §2). The run whose `CLAUDE_CODE_SESSION_ID` equals that earliest
  claim's embedded session proceeds to mutate; every other backs off. **Fail-closed:** if
  `CLAUDE_CODE_SESSION_ID` is absent the claim can't be posted and the run **aborts the acquire**
  (it never falls back to the login-keyed label as an ownership signal — that is the degeneracy
  ADR 0115 removes); if no authorized claim resolves, no run wins.

- **The loser retracts its own claim, never the shared label.** A co-acquire loser **`DELETE`s
  its own planning-claim comment** — via the **comment-scoped** endpoint
  `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}` (no issue number; the
  issue-scoped `issues/{n}/comments/{id}` form **404s** and leaks the claim, wedging the epic —
  #1548) — and backs off — it does **not** `DELETE` the `status:planning`
  label, which the **winner still holds**. Unlike §7's per-login assignees (where each agent
  removes *its own* assignee), the label is a **single shared token both runs `POST`ed**, so
  deleting it would unlock the winner and reopen the double-plan. The release-on-every-exit
  discipline is unchanged for the **winner**: it holds the label **PASS-or-park**, then `DELETE`s
  both its own claim comment and the label on **every** terminal path including failure. **Only
  release a lock you won**, never the held label you backed off from.

This swaps the label's degenerate "any non-null = held, but which run?" for **earliest authorized
claim wins**, resolved by the same detect-and-serialize, fail-closed shape as §7 — and because
earliest-claim-wins, **Rule 0 (defer to a holder) and the tiebreak are the same fact** (the
pre-existing planner *is* the minimum, ADR 0115 §2). It remains **detect-and-serialize, not a
mutex** — neither the label nor the comment API offers a conditional write, so the residual
co-acquire window (both posting in the same instant) is narrowed and resolved, not eliminated;
it stays backstopped by the epic-body **splice + recheck** (§1 "Updating it safely", #261) and
the convergence loop's signature checkpoint. Don't claim a lock guarantee the API can't give —
claim "of any set of co-acquirers, exactly one plans; every loser self-retracts and backs off."
See ADR [0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md)
(the lock) and ADR [0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md)
(the agent-distinguishable claim, #1452).

## Milestone — the fourth intake dimension

`type:*`, `p*`, and `status:*` are **mandatory** dimensions: every issue carries exactly one of
each, and an issue missing any of them is malformed. **Milestone is the fourth**, and it lives on
the issue's native `milestone` field rather than a label.

**Optionality is bounded by the standing-lane rule (ADR 0202/0208, #3939).** Milestone used to be
the *optional* dimension — most issues carried none and absence was the norm. That no longer holds
at the **triage** seam: an issue that leaves triage is **homed** in an arc/campaign milestone,
**or** carries one of exactly two standing-lane labels (`wayfinder:backlog`,
`axis:pipeline-hardening`), **or** is killed — ADR
[0208](https://github.com/kamp-us/phoenix/blob/main/.decisions/0208-standing-lane-exemption-from-full-homing.md)
amends ADR 0072 §4/§5 in part, and `triage`'s "Assign a home" step owns the behavior. Everything
below — what a milestone encodes, the two kinds, the never-create rule, the REST surface, the read
side — is unchanged.

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
autonomous "create-milestones" skill (ADR 0072 §3). **At the triage seam**, a skill that finds no
clear match to an existing open milestone still does not invent a home — it reaches for a
**standing-lane label or a kill**, per the fallback rule immediately below (ADR 0202/0208).
"Leave it unmilestoned" is **not** a triage outcome. (`plan-epic`'s inheritance is a different
act — children of an unmilestoned epic stay unmilestoned; see the write side below.)

**Freeze-by-absence moved from an absence to a label (ADR 0208).** The signal ADR 0072 §4 carried
— *this work is parked by design; don't force-fit it* — is not retired, but it no longer rides on
a bare absence. It rides on the two standing-lane labels: `wayfinder:backlog` (fog, homed when
charted — ADR 0203) and `axis:pipeline-hardening` (the permanent hardening lane). For an issue
outside those two, an empty milestone after triage reads as **un-homed**, not parked. Unchanged:
a skill still never force-fits or invents a home to make an issue look "complete" — the honest
outcomes are a real home, a standing-lane label, or a kill.

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

- **`triage`** **homes** every issue it triages: an **existing open** arc/campaign milestone, or
  one of the two standing-lane labels, or a kill (ADR 0202/0208 — `triage`'s "Assign a home" step
  owns the procedure and cites this section). The guardrails are unchanged in kind: keep the match
  honest (a wrong milestone pollutes that burndown worse than the issue's absence from it), assign
  to an **existing open** milestone only, and **never create** one. What changed is the fallback —
  "leave it unmilestoned" is no longer an outcome; a standing-lane label or a kill is.
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

## The product-development cycle hook

The pipeline skills ship as a **portable plugin** (ADR 0062): an adopter installs them into
*their* repo, which may have no feature-flag substrate and no notion of a containment cycle.
Yet phoenix wants the autonomous pipeline to **ship user-facing changes dark by default** — a
bad auto-merge stays contained behind a default-off flag until a human deliberately releases
it (**agents own deployment, humans own release** — ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)).
Reconciling the two means the pipeline skills become **cycle-interpreters**: they consult a
repo-owned cycle doc for the containment policy, and when it is absent they **no-op
gracefully**, staying flag-agnostic and portable (ADR 0062).

This section is the **single source of truth** for the two generic primitives every cycle-aware
skill depends on — the cycle-doc **consult hook** and the per-child **`**Containment:**`
marker** — so the dimension can't drift across skills (the exact single-source discipline the
§CP control-plane set and the §Milestone section already enforce). The per-skill *behavior*
(plan-epic stamps, write-code ships dark, review-code verifies the gating) lives in those
skills and **cites this section**. The phoenix-specific cycle *content* — what the cycle
actually mandates — lives in the repo-root `product-development-cycle.md`, **not** here: this
section defines the generic hook and marker, that doc fills them in.

### 1. The cycle-doc consult hook + graceful-absence contract

The well-known repo path the cycle-aware skills consult is **`product-development-cycle.md`
at the repo root** (alongside `README.md` / `CLAUDE.md`, for the same discoverability). A
cycle-step **probes for the doc first**; if it is **absent**, the step **no-ops** — it stamps
no marker, enforces no dark-ship, surfaces no release queue. This is the **graceful-absence
contract** that keeps the plugin portable (ADR 0062): a foreign install with no cycle doc runs
the pipeline exactly as it did before this dimension existed.

Every consumer cites **this one canonical probe** — a content read against `$REPO`'s default
branch (no second copy in any skill):

```bash
# probe the well-known cycle doc; absent ⇒ the cycle-step no-ops (graceful absence, ADR 0062)
if gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  CYCLE_DOC=present   # consult it for the containment policy
else
  CYCLE_DOC=absent    # no-op: no marker, no dark-ship, no release queue
fi
```

A skill operating on a **local working tree** rather than the GitHub API (e.g. an offline
build step) may substitute the equivalent working-tree check — `test -f
product-development-cycle.md` at the repo root — for the `gh api` content read; the two are
the same probe against the same well-known path, and both must treat **absent ⇒ no-op**.

The probe is the **only** gate on every cycle-step: a step never assumes the doc exists, never
hard-codes phoenix's policy, and never fails because the doc is missing. Absence is a
first-class, correct state — a repo with no cycle is a repo the cycle steps no-op on — not a
defect to repair.

### 2. The per-child `**Containment:**` marker

The cycle's per-child decision is carried as a **`**Containment:**` line** in the
[§2 sub-issue body format](#2-sub-issue-body-format), alongside `**Stories:**` / `**TDD:**` —
reusing the existing `**Key:**` field idiom so no new parser is needed. Its **canonical
values**:

| Value | Meaning |
|---|---|
| `flag (default-off)` | A **user-facing** change → it must **ship dark** behind a default-off flag (the agent-workflow pattern, `.patterns/feature-flags-agent-workflow.md`). |
| `exempt (<reason>)` | A change with **no behavior to hold dark** — an **internal / refactor / infra / docs** change with no user-facing surface, **or** a **client-only presentational** change whose entire user-facing effect is *which pixels render* (ADR [0161](https://github.com/kamp-us/phoenix/blob/main/.decisions/0161-containment-exempts-client-only-presentational-change.md)). The `<reason>` names which (e.g. `exempt (internal refactor)`, `exempt (docs)`, `exempt (client-only presentational)`). See the [exempt-vs-not-exempt boundary](#the-exempt-boundary-behavior--access--state-delta-adr-0161) below. |
| `none (no cycle doc)` | The **graceful-absence** value: the repo has no `product-development-cycle.md`, so no containment is required. This is what a foreign install's children carry. |

**The tolerant-read rule:** a **missing `**Containment:**` line reads as `none`** — treated as
"no containment required," identical to `none (no cycle doc)`. This is the [§Reading stance](#reading-stance-convention-not-parser-spec)
tolerant-reading stance applied to this field: a child filed before the dimension existed, or in a repo with no
cycle doc, is well-formed and unblocked, not malformed. (Contrast `**Stories:**`, which is
required — `**Containment:**` is optional, and its absence is a valid value, not a defect.)

<a id="the-exempt-boundary-behavior--access--state-delta-adr-0161"></a>
### The exempt boundary — a **behavior / access / state delta** (ADR 0161)

`flag (default-off)` holds an **autonomously-merged behavior change** dark until a human validates
it. A change with **no behavior to validate dark** has nothing for the flag to protect, so it is
**`exempt`** — the flag would be a no-op guard adding ceremony and a manual flip while reducing zero
risk. The boundary is a **user-visible behavior / access / state delta**, *not* "does the code branch
on data" — draw it exactly per ADR
[0161](https://github.com/kamp-us/phoenix/blob/main/.decisions/0161-containment-exempts-client-only-presentational-change.md)
(which refines the ADR-0083 containment scope):

- **EXEMPT — stamp `exempt (<reason>)`, ships live:** a change whose entire user-facing effect is
  **presentational** — *which pixels render*: CSS-only / styling / layout / spacing / density / motion,
  and **pure client perceived-perf** with no data / logic / security surface. **A presentational
  conditional is still exempt** — rendering different pixels off already-loaded data (an **empty
  state**, a **loading skeleton**, a **responsive / density layout**) changes only *what is painted*.
  A **branch on data alone is not a behavior change**; it adds/removes no control, gates no feature,
  mutates no data, persists no observable state.

- **NOT EXEMPT — stamp `flag (default-off)`, ships dark:** any **behavior / access / state delta** —
  a **data** change, **logic** (a new decision that changes what the app *does*), a **behavior flag**,
  **auth** (an access / permission decision), or a **persisted / observable state change**. **The
  access edge:** **CSS that HIDES or DISABLES a functional control is an access change, not
  presentation** — a `display:none` / `visibility:hidden` / `pointer-events:none` that removes users'
  access to a working control changes *what the user can do*. **The line is access, not the CSS
  property** — a style that only changes a still-usable control's *appearance* stays exempt; one that
  revokes access to it does not.

- **When genuinely ambiguous, contain — fail closed.** If you cannot tell whether a change is
  presentational-only or carries an access / behavior / state delta, stamp `flag (default-off)`, **not**
  `exempt` — never exempt on a guess. The exemption removes ceremony only from the class that
  *provably* has nothing to protect; a too-wide exemption re-admits the behavior changes ADR-0083
  contains. Claiming the exemption means **saying so** (a deliberate `exempt (<reason>)`, recorded, not
  a bare/omitted line that reads as `none`), so the classification is legible and the reviewer catches
  a mis-stamp per-PR.

### Who writes it, who reads it

Mirroring the §1 / §2 / §Milestone "who writes, who reads" convention, the marker has one
writer and two readers:

- **`plan-epic` writes it.** When it mints a child, plan-epic runs the consult-hook probe; if
  the cycle doc is **present**, it consults the cycle's policy and stamps the child's
  `**Containment:**` accordingly (`flag (default-off)` for a user-facing **behavior** child, `exempt
  (<reason>)` for an internal/refactor/docs child **or** a client-only presentational one — per the
  [exempt boundary](#the-exempt-boundary-behavior--access--state-delta-adr-0161), containing on
  genuine ambiguity). If the doc is **absent**, the step no-ops and the child carries
  `none (no cycle doc)` (or, equivalently, no line at all). plan-epic is the **only** writer.
- **`write-code` reads it.** When it picks a child marked `flag (default-off)`, write-code
  ships the change **dark** behind a default-off flag per the agent-workflow pattern; an
  `exempt`/`none` child ships normally. write-code never writes the marker.
- **`review-code` reads it.** On a `flag (default-off)` PR, review-code verifies the gating
  (default-off declaration, safe read default, no leak) as part of its gate; an `exempt`/`none`
  PR needs no gating check. review-code never writes the marker.

The per-skill mechanics of each of those (how plan-epic decides user-facing-ness, how
write-code ships dark, what review-code checks) live in those skills and cite this section, so
the field's grammar stays defined exactly once. See ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)
for the why (agents deploy / humans release) and ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)
for the portability guarantee the graceful-absence contract delivers.

## The PR `area:*` signal — a join-free product/infra tag for the ship digest

The **product-vs-infra split** is the top level of the founder-facing `ship-digest` readout
(`pipeline-cli ship-digest`) — did this shipped work touch a kamp.us **product** surface, or the
pipeline / infra **substrate**? That split lives naturally on the **issue** (via its milestone /
campaign), but a **merged PR carries no milestone** — milestones live on issues only. So the digest
would have to recover the split by a fragile **PR→issue→milestone join** on every readout. The
`area:*` **PR label** is the cheap tag that makes the split **join-free**: stamp the merged work's
section directly on the PR, and the digest reads it without touching the issue graph.

**The convention.** A merged PR may carry **exactly one** of two labels:

| Label | Meaning |
|---|---|
| `area:product` | The work touches a **kamp.us user-facing product** surface (sözlük / pano / the web app). |
| `area:infra` | The work touches the **pipeline / infra / platform substrate** — no user-facing surface. |

**Who applies it.** `ship-it` stamps it **at merge**, echoing the section the PR's linked
`Fixes #N` issue already implies (its milestone / product surface) — the merge authority is the one
point that reliably knows the PR↔issue link, so it echoes the signal onto the PR join-free for
later readouts. A **human** may set it earlier (on the PR at open) when the section is obvious;
`triage` does **not** — it operates on issues, not PRs, and this is a PR-level tag. It is **not**
enforced by any gate (retrofitting it onto historical PRs, and any enforcement guard, are
explicitly out of scope — a later chore if wanted).

**The absent-default (tolerant read).** The label is **optional**: a PR without an `area:*` label
is well-formed, not a defect (the same tolerant-read stance as a missing `milestone`). When it is
absent the `ship-digest` gather falls back to the **PR→issue→milestone join** to recover the
section, and when *that* yields nothing the digest defaults the entry to **`Product`** (the
reader's default frame) — never dropped. So the signal only ever makes the readout *richer and
cheaper*; its absence degrades cleanly to the pre-convention join behaviour, never worse.

**Who reads it.** `ship-digest` is the consumer. Its pure core resolves each entry's section with a
**PR-signal-preferred precedence** (`resolveSection` in
`packages/pipeline-cli/src/tools/ship-digest/digest.ts`): the entry's `area` (the PR `area:*`
signal, join-free) wins; when absent the gather-supplied `joinedArea` (the PR→issue→milestone join
fallback) is consulted; when neither is present it defaults to `Product`. The `/what-shipped`
gather is what populates `area` from the PR label (join-free) and `joinedArea` from the join when
the label is missing.

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
**Containment:** flag (default-off) | exempt (<reason>) | none (no cycle doc)

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
- **Containment** — the **per-child containment marker**: which cycle-step containment a
  user-facing change must carry on merge. It is the field the cycle-aware skills read off a
  child; its canonical values, its tolerant-read rule, and who writes vs reads it are defined
  once in [§The product-development cycle hook](#the-product-development-cycle-hook) (the same
  single-source discipline §Milestone uses) — read that section for the contract, not this
  bullet. The short of it: `flag (default-off)` for a user-facing change (→ ship dark),
  `exempt (<reason>)` for internal/refactor/infra/docs, `none (no cycle doc)` for a foreign
  install with no cycle doc; a **missing line reads as `none`** (no containment required).
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

## PITCH. The pitch — the direction carrier that binds at intake (founder ruling #3909)

This is the **single source** of the pitch format and its founder-approval carrier. Every
consumer — `triage` (drafts it), `write-code` (reads it as the bet it is building),
`pitch-guard` (enforces it), and the cycle heartbeat — cites *this* section; none re-derives
the field set or the approval rule.

**Why it exists.** The factory runs AFK, so direction cannot be enforced by founder attention.
It binds **structurally at intake**: lane-entering work enters the drain only carrying a
founder-approved pitch. The founder ruling that fixes this also fixes its **inverse** — *no
merge-blocking conformance gate on shipped work.* A finished PR **never** fails for direction
(#3909). Anything that would red a PR for a missing or malformed pitch is out of contract.

### The five fields

The pitch is a body section headed `## Pitch`, carrying exactly five fields:

```markdown
## Pitch

**Problem:** <who has it, and what breaks or stalls for them today — one or two sentences>
**Arc:** <the arc-home this work belongs to — the milestone or standing lane the ADR 0202 rubric step already assigned>
**Appetite:** <N> cycles
**Rabbit-holes:** <the named traps — the specific ways this overspends if left unbounded>
**No-gos:** <what this deliberately does not do>
```

- **Problem** — the *who* and the *what hurts*, not the solution. A pitch whose Problem is a
  restatement of the proposed change has not found its problem yet.
- **Arc** — **the arc-home outcome of the existing rubric step, restated as a field; it is not
  a second check.** `triage`'s ADR-0202 home-or-exempt-or-kill step already resolved this issue
  to a milestone or a standing lane; **Arc** carries that same answer into the pitch so the bet
  is legible without a second read. There is exactly **one** arc question in the pipeline and
  `homing-guard` is its teeth — never add a parallel arc check here.
- **Appetite** — the **founder-set spend ceiling, denominated in 2-week cycles** (the cycle
  length is founder-set, #3227). It is a *budget*, not an estimate: it says how much this is
  worth, not how long it will take. A whole positive number of cycles; `1 cycle` / `2 cycles`
  both read.
- **Rabbit-holes** — the named traps, so the appetite is spendable. Generic caution ("don't
  over-engineer") is not a rabbit-hole; a specific one is.
- **No-gos** — the deliberately-excluded scope. This is the field that makes a bet finishable.

Read it **tolerantly** per [§Reading stance](#reading-stance-convention-not-parser-spec) — bold
markers optional, `Rabbit holes` reads as `Rabbit-holes`, field order is not load-bearing — but
**write it canonically**, in the shape above.

### The founder-approval carrier — a founder seat, never agent-satisfiable

**Agents draft; only the founder approves.** The draft is agent work and the approval is a
**human seat**, exactly like the betting-table verdict and the appetite number itself (#3927).
Approval is carried by one comment on the issue:

```
pitch-approved: appetite <N> cycles · <ISO-8601-UTC>
```

A comment counts as an approval only when **all** of these hold — a miss on any one resolves
to *not approved*, never to a warning:

1. **`write+` authored.** The comment's author is a `write+` repo collaborator, resolved at the
   GitHub ACL, fail-closed — the same [ADR 0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
   trust root every verdict marker uses. Never a checked-in allowlist.
2. **Not agent-authored.** The comment carries **no agent-provenance stamp** — no
   `Filed by an agent` footer, no `session <uuid>`, no bare session UUID. This is the
   [§4.5](#45-the-filing-provenance-signal--the-report-footer-not-github-authorship-adr-0159)
   signal applied to approval, and it is the load-bearing clause: **GitHub authorship cannot
   distinguish founder from agent** (both write through the shared `usirin` token — the same
   degeneracy [§7](#7-issue-claim-semantics--a-session-id-stamped-claim-comment-the-agent-distinguishable-claim-marker-adr-0115) / ADR 0115
   removes for the claim marker), so the tell is the *stamp*, not the login. The complement is
   an obligation on the write side: **every agent-posted pipeline comment is provenance-stamped,
   and no agent ever posts a `pitch-approved:` marker at all.** A stamped marker is, by
   construction, not an approval.
3. **Bound to the appetite it approved.** The marker's `<N>` equals the body's **Appetite**
   field. The founder approves a *specific* number, so re-writing the appetite after approval
   silently un-approves the pitch rather than inheriting a ceiling he never set — the same
   staleness-binding discipline [ADR 0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)
   gives a verdict against a head SHA.

**The honest residual.** Clause 2 is convention-carried, not cryptographic: an agent that
suppressed its own provenance stamp could forge an approval. That is the same residual §4.5
accepts for the never-auto-close signal, and it is named here rather than papered over. The
structural half is that no agent-facing skill has a `pitch-approved:` write path — approval has
no producer inside the pipeline.

### Who writes it, who reads it

| | |
|---|---|
| **Drafted by** | `triage`, into the issue body at the home-or-exempt-or-kill step (`triage/SKILL.md` Step 6) |
| **Approved by** | the **founder only** — the `pitch-approved:` comment, per the three clauses above |
| **Enforced by** | `pipeline-cli pitch-guard check [--issue <N>]` — fail-closed, ADR 0092 |
| **Read by** | `write-code` (the bet it is building), the appetite circuit breaker (#3966), the cycle heartbeat (#3948) |

### Scope — what "lane-entering work" means here

The pitch requirement binds **lane-entering work**: an open `status:triaged` issue that is a
**`type:epic`**, or a **`type:feature` with no parent** (a standalone build feature). A child of
an epic **inherits its epic's pitch** and carries none of its own — the bet was placed at the
epic. Every other type (`type:bug`, `type:chore`, `type:decision`, `type:investigation`) is
**out of scope**: maintenance and questions are not bets.

> **Park and expiry are NOT defined here — they are #3966's carrier.** A pitch that outspends
> its appetite parks for a founder re-pitch, and parked-unpitched work expires; the park marker
> and its semantics (including how they relate to ADR 0072 §4) are defined **once**, by the
> appetite-circuit-breaker child [#3966](https://github.com/kamp-us/phoenix/issues/3966), and
> that question is **open** at the time of writing. This section deliberately encodes **no**
> answer to it and no consumer may infer one from the pitch fields.

---

## The `wayfinder:map` issue shape

A `wayfinder:map` issue (the [`wayfinder:map` label](#the-wayfindermap--wayfinderbacklog-ideation-layer-markers--not-pipeline-states-not-type)) is not a task and not an epic — it is a **living map**: the
ideation-layer surface the `wayfinder` skill's **chart** and **work** modes and the wayfinder
CLI all read and write. This section is the **single source** of that body shape, so every one
of those consumers cites *one* definition and cannot drift (the same single-source discipline
§Milestone and §CP use). The map is a **shared state contract**, not free prose: its four
sections are the durable seam between the modes, so a `wayfinder work` run picks up cold from
what a prior `chart`/`work` run left on the map.

The *why* — what the ideation layer is and how it feeds the pipeline — lives in the
[`wayfinder` skill](wayfinder/SKILL.md); this section is the **contract**.

### The four sections

A `wayfinder:map` issue body carries exactly these four sections, in order:

- **`## Destination`** — the named end-state the map is charting toward: one or two sentences
  stating *where we want to be*, concretely enough to tell "arrived" from "not yet." This is the
  fixed star the map steers by; it changes rarely, and only in **chart** mode.
- **`## Decisions-so-far`** — the **accreting answer log**: the settled decisions and
  established facts, newest last, each a one-line entry naming *what was decided/found* and its
  resolvable origin (`— from #N`). This is the map's growing spine of certainty; a **work** run
  appends to it as it resolves each frontier ticket. Nothing is ever deleted here — a decision
  that is later revisited gets a new superseding entry, so the log stays auditable. **Every entry
  carries a `— from #N` origin** (the validator's auditability floor); the `#N` differs by *how*
  the entry entered the log:
  - **A WORK-mode append** cites the **frontier ticket** it resolved — `— from #<frontier-ticket>`.
  - **A CHART-time seed** (a founder given brought in at charting, and an in-session founder
    ruling recorded during a chart/work run) has **no frontier ticket** to cite — it is
    attributed to the **map's own issue number**, `— from #<MAP>`. The seed *came from* the chart
    act that created the map, so the map number is its honest origin; this keeps the seed
    resolvable and auditable without inventing an unattributed form. A history-shaped given whose
    provenance is a person still uses `— from #<MAP>`, carrying the *who* alongside the ref (e.g.
    `— from #<MAP> (@founder)`), never *instead of* it — see the [`wayfinder` skill](wayfinder/SKILL.md)'s
    CHART step 3 for when a design-history given may be seeded at all.
- **`## Open frontier`** — the **live edge of the unknown**: the open investigation and decision
  tickets, kept as **native sub-issues** of the map (so each is a real, linkable, closable
  GitHub issue, reusing the existing infra). Each line references its sub-issue and states the
  open question. A ticket flagged a **founder-decision-fork** is marked as such — `wayfinder`
  surfaces it and stops rather than auto-resolving it (the preserved human seam). This section
  shrinks as tickets are answered and grows as answers reveal new unknowns; the map is "done
  enough" for handoff when it holds no more *answerable* unknowns.
- **`## Graduated fog`** — the **cleared unknowns**: tickets whose answers have been recorded
  into `## Decisions-so-far` and whose resolution *graduated* them off the frontier (often
  spawning the next frontier ticket in the process — that is the map's forward motion). Each
  line references the now-closed sub-issue and, where it spawned follow-on frontier, names it
  (`→ spawned #M`). This is the map's history of motion: the record of *how the fog cleared*,
  distinct from `## Decisions-so-far`, which records *what was decided*.

The invariant tying them together: **a ticket leaves `## Open frontier` only by its answer
landing in `## Decisions-so-far` and the ticket moving to `## Graduated fog`** — the three move
in lockstep, so the map is never left in a state where a resolved unknown has no recorded
answer.

### Worked example

```markdown
## Destination
kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new person in, and
that person lands as a çaylak with a clear first-run path — no founder in the loop.

## Decisions-so-far
- The çaylak → yazar path is vouch-gated (kefil), not open signup — a founder given brought in at
  charting. — from #100 (@founder)
- Invites are karma-gated, not seat-gated — a yazar spends no quota, the çaylak's own karma
  ramp is the throttle. — from #101
- The invite artifact is a single-use signed link, not an in-app request/approve handshake. — from #102

## Open frontier
- #103 — Investigation: does better-auth's session model let us mint a single-use invite token
  without a new table, or do we need an `invite` store of record?
- #104 — Decision (founder-decision-fork): should an invited çaylak start at 0 karma or inherit
  a small vouch-backed starting balance? (options + trade-offs surfaced; awaiting founder)

## Graduated fog
- #101 — Decided invites are karma-gated. → spawned #104 (starting-balance question)
- #102 — Decided the artifact is a signed link. → spawned #103 (token storage investigation)
```

The map here is `#100`. Its first `## Decisions-so-far` entry is a **CHART-time seed** — a
founder given with no frontier ticket to cite — so it is attributed `— from #100`, the map's own
number (with `(@founder)` naming the *who*). `#101`/`#102` have graduated (their answers are in
`## Decisions-so-far`, they sit in `## Graduated fog`, and each spawned the next frontier ticket,
so those two entries cite their **frontier tickets**), `#103` is an answerable investigation
`work` mode can clear, and `#104` is a **founder-decision-fork** `wayfinder` surfaces and stops
on — never auto-resolves.

### Field notes

- **Read tolerantly, write canonically** (per §Reading stance): a map that spells a heading
  slightly differently, or carries an extra note under a section, still means what it means;
  emit the four canonical section headings.
- **The sub-issue infra is reused, not reinvented.** Frontier tickets are ordinary GitHub
  sub-issues of the map — they carry their own `type:*`/`status:*` as any issue does once they
  graduate into the execution pipeline; on the map they are referenced by number, not copied.
- **The map is not `write-code`-pickable.** Only the concrete work a map *graduates* into
  `triage` / `plan-epic` becomes pickable execution issues; the map itself is worked by
  `wayfinder`, never picked by `write-code`.
- **A `wayfinder:backlog` destination has no map body yet.** The [`wayfinder:backlog`
  label](#the-wayfindermap--wayfinderbacklog-ideation-layer-markers--not-pipeline-states-not-type)
  marks a destination *queued* for charting — a named end-state, not yet a living map — so it
  carries no four-section shape. Charting it is what *produces* this body shape: a
  `wayfinder:backlog` destination graduates when the cartographer charts it into a
  `wayfinder:map`, which then graduates its cleared frontier into emitted factory work. Like
  the map, it is never picked by `write-code`.

---

## Posting a comment body — read it into `$BODY`, never `gh api -f body=@file` (the local-path leak)

Formats 3 and 4 (and every claim/handoff comment below) are posted with `gh api … -f body=…`.
There is **one** correct way to pass a body, and one form that is **forbidden** because it
silently leaks a local path into a **public** comment:

- **Required form — assemble the body into a shell var, then pass it by value.** Build the text
  (a heredoc, or a scratchpad file you `cat`), read it into `$BODY`, and pass `-f body="$BODY"`:

  ```bash
  BODY="$(cat "$BODY_FILE")"                       # or: BODY=$(cat <<'EOF' … EOF)
  gh api repos/$REPO/issues/<N>/comments -f body="$BODY"
  ```

- **Forbidden form — NEVER `gh api -f body=@<path>` (equivalently `--raw-field body=@<file>`).**
  `gh api`'s `-f`/`--raw-field` adds a **static string** parameter: it takes the value *verbatim*
  and, unlike `curl`, does **not** expand a leading `@` into the file's contents. So
  `-f body=@/some/path` posts the raw text `@/some/path` as the comment body — two harms in one:
  (1) the intended body never renders, and (2) the literal value is typically a machine-local
  absolute path (a `mktemp`/scratchpad file), so a **local filesystem path leaks into a public
  GitHub comment**, violating the no-local-paths-in-shared-artifacts invariant (`CLAUDE.md`). The
  `leak-guard` CI gate scans **committed files**, not comment bodies posted at runtime, so nothing
  catches this after the fact — the leak lives in the public comment until a human spots it (the
  manually-patched comment on PR #1567). If you find yourself reaching for the curl-style `@file`
  idiom, stop and use the `BODY="$(cat …)"` → `-f body="$BODY"` form above.

  (Only `-F`/`--field` — the *typed* flag — reads a file via `@`, per `gh api --help`. Do not
  route around this with `-F body=@file`: the `$BODY`-by-value form is the single idiom every
  skill here uses — reach for it, not a second mechanism.)

### The verdict read-back guard — after posting a gate marker, re-read it and FAIL LOUD (`verdict_readback_guard`)

The by-value form above (`-f body="$BODY"`) is the *source* idiom; it prevents a `body=@<path>`
leak **at the call site**. But a source idiom cannot catch a **runtime deviation** — an agent that
hand-assembles the wrong `$BODY` (the literal temp path as the marker body, a body missing its
`Reviewed-head:` anchor, or a silently no-opped post) still lands a broken marker the by-value form
happily transmits. That is the #2148 class: the posted verdict comment's entire body was a local
temp path (`@/var/folders/…`), so no SHA-bound verdict existed for `ship-it` / the §CP merger to
bind to (a **missing** gate verdict), **and** it leaked a machine-local path into a public comment.
The source idiom alone can't see it; only a **post-write read-back** can.

So every gate that posts a verdict marker — `review-code`, `review-doc`, `review-skill`,
`review-design` — closes the loop with **one** canonical read-back guard: after the post/upsert
lands, **re-read the comment you just wrote** and assert three invariants, failing **loud**
(fail-closed, ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md) §ZS)
on any miss — never a silent pass. This is the single source; each review skill **references it**
(it does not re-derive its own copy — the three-copy drift is exactly what this contract exists to
prevent):

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/verdict-readback.sh"                                  # §SHARED: both guards, one source
verdict_readback_guard "$CID" review-code "$HEAD_SHA" || …          # <gate> ∈ review-{code,doc,skill,design}
```

[`shared/scripts/verdict-readback.sh`](shared/scripts/verdict-readback.sh) carries the four checks and
their reasons: **(0)** a non-empty body, **(1)** a canonical `<gate>:` marker — the bindable
`PASS|FAIL @ <sha>` first line or the SHA-less `advisory` one, **(2)** the SHA-source-aware head
binding, **(3)** no local-filesystem-path leak. Any miss returns non-zero and names the cause.

Gate it exactly like the by-value post it follows: right after the `PATCH`/`POST` upsert returns the
comment id, call `verdict_readback_guard "$CID" <gate> "$HEAD_SHA"` and, on non-zero, **re-post the
real verdict and re-assert** — if it still cannot land clean, surface it as a **posting failure** in
the run ledger (the PR is genuinely ungated; a consumer must not read it as verified), never swallow
it as a silent success. A moved `HEAD_SHA` between the post and the read-back means the head advanced
*during* the review — re-resolve the head, re-verify against it (the gate is stateless), and re-post;
never loosen the match to paper over a moved head. (In practice a gate never calls this primitive with
a hand-carried id — it calls the unconditional `verdict_post_verify` wrapper below, which resolves the
landed comment id by re-scanning PR state and passes it here.)

Check (2) is **SHA-source-aware** (#2272): the read-back fires on every verdict type without
false-failing a legitimate non-blocking PASS. The bindable PASS/FAIL first line satisfies (1) via its
`@ <sha>` — that SHA **is** the head binding, so (2) requires no separate `Reviewed-head:` line (the
non-blocking binding templates carry the SHA only on the first line; this is the branch that keeps a
clean non-blocking doc/skill PASS from false-failing under the unconditional `verdict_post_verify …
|| exit 1`). The advisory blocking-set path carries no first-line `@ <sha>` by design (ADR 0111),
which is why (1) accepts the `<gate>: advisory` first line; it binds the head **in the body** via the
canonical `Reviewed-head: @ <sha>` line, which §6.6/ADR 0151 mandates on **all four gates'** advisories
— **review-code included** (#2329: the earlier "review-code's §CP advisory carries NONE by design →
accept its absence" carve-out contradicted §6.6's MUST and blinded (2) to a drifted `**Reviewed head:**`
variant, which ship-it's §6.6 enqueue matcher then rejects; the carve-out is removed, so a missing or
drifted advisory head-binding fails **loud at emission** rather than surfacing as a ship-it refusal on
an approved PR). Any `Reviewed-head:` line present but bound to the wrong sha is always fatal. The
canonical-marker check (1) and the leak check (3) are **unconditional** on every verdict type — the
#2148/#2264 path-leak protection is never relaxed.

### Make the read-back UNCONDITIONAL — resolve the landed verdict from PR state, never a carried id (`verdict_post_verify`)

`verdict_readback_guard` above is correct but only fires **if it is reached with the right comment
id**. The #2264 recurrence (after #2148/#2153 already "fixed" the leak) proves that condition is the
real gap: the guard was invoked as `verdict_readback_guard "$MINE" …`, and `$MINE` is populated on
**one** posting branch only (the APPROVE-failed comment-upsert `else` fallback). A verdict that lands
by any **other** path — the native `APPROVE`, a first-verdict `POST` on a branch that didn't set
`$MINE`, or an agent hand-rolling `gh api -f body=@file` — reaches the guard with an **empty** id, so
the guard reads nothing and the broken/leaking marker sails through. A guard you can skip by taking a
different post branch is not a guard.

The fix is to **stop trusting a carried variable and re-derive the landed verdict from live PR
state**, then run the read-back **unconditionally** on whatever landed. This is the single wrapper
every gate calls after posting — it resolves the marker comment id by re-scanning, proves *a* verdict
actually landed for the head, and **hard-fails (non-zero)** on absent / broken / leaking so a garbled
or path-leaking marker is a **fatal** error the gate cannot silently pass:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/verdict-readback.sh"                                  # §SHARED: the wrapper and the guard it calls
verdict_post_verify "$PR" review-code "$HEAD_SHA" || exit 1         # UNCONDITIONAL, after ANY post/upsert
```

It resolves the landed verdict from live PR state — **(A)** my SHA-bound or advisory marker comment,
**(B)** a native `APPROVE` whose `commit_id` is this head — never from a carried `$MINE`/`$CID`; then
**(C)** hard-fails when nothing bound to the head landed, **(D)** runs the read-back on the landed
comment whichever branch posted it, and **(E)** leak-checks the native-`APPROVE` body too. Returns 0
only on a proven-clean landed verdict.

**Why this closes the #2264 recurrence — the post-path enumeration.** Every way a gate can land a
verdict now routes through the same unconditional read-back, because `verdict_post_verify` resolves
the landed surface from PR state instead of from a branch-local variable:

- **native `APPROVE`** → resolved by (B); its body is leak-checked by (E); commit_id is its SHA anchor.
- **comment `PATCH`-upsert** (the old `$MINE` branch) → resolved by (A); shape+leak by (D).
- **comment `POST`** (first verdict, `$MINE` empty) → resolved by (A); shape+leak by (D). *This is the
  branch the carried-`$MINE` call silently skipped.*
- **advisory comment** (§CP blocking-set) → resolved by (A) via the `<gate>: advisory` arm; shape+leak by (D).
- **hand-rolled `gh api -f body=@file`** (the literal path as the whole body) → has **no** `<gate>:`
  first line, so (A) resolves empty and (B) is 0 ⇒ **(C) fatal** (`ungated`). A garbled marker is fatal.

The single **fatal** exit on absent/broken/leaking is the load-bearing change: the prior Step-4c
presence check merely *echoed* a warning and re-posted without a non-zero exit, so a garble read as
green. Callers **must** propagate the non-zero — `verdict_post_verify … || exit 1` — so the gate
cannot report itself done over an ungated PR.

Gate it exactly like the by-value post it follows: right after the last of the Step-5/4a-4b upsert
branches runs, call `verdict_post_verify "$PR" <gate> "$HEAD_SHA" || exit 1`. On a moved `HEAD_SHA`
between post and verify the head advanced *during* review — re-resolve the head, re-verify against it
(the gate is stateless), and re-post; never loosen the match to paper over a moved head.

### The guarded emit path is MANDATORY — never hand-post a verdict marker off the guard

`verdict_post_verify` above is the *read-back*: it re-scans PR state **after** a post and fails loud
on a marker that landed broken or leaking. But a read-back cannot police a post it never sees. An
agent that **hand-posts** the verdict marker with a raw `gh api …/comments` or `gh pr comment` call
bypasses the verdict lib entirely, so `emissionDefect` never fires — and, worse, the marker often
never resolves through `verdict_post_verify`'s re-scan either, so nothing catches it. That is the
**emit-side hole** the recurrences rode: #2789 (the whole body was an `@filepath`), #2816 / #2818 (a
`/var/folders` mktemp path glued into the `@ <sha>` field) — each leaked because the marker was
hand-posted off the verdict lib, not because the lib's guard was wrong. Code cannot force a hand-post
through a guard the reviewer never invokes; the **emit path itself** must be mandated, not just
described.

So for **all four PR gates** — `review-code`, `review-doc`, `review-skill`, `review-design` — routing
every verdict-marker post through the guarded path is a **hard invariant, not a suggestion**:

- **MUST** post every verdict marker through `pipeline-cli verdict post` — the single marker-emit
  choke point that runs `emissionDefect` (the body-wide machine-local-path scan added by #2823, plus
  the 40-hex `@ <sha>` field guards, #2683) and **refuses fail-closed** on a leaking or malformed
  body. For the native `APPROVE` review body (which `verdict post` cannot emit), run the **same** gate
  as an explicit read-back assertion — `verdict validate` — **before** the `APPROVE`, so a
  malformed/leaking marker fails loud rather than landing in a public review body.
- **FORBIDDEN:** a bare `gh api …/comments` / `gh pr comment` hand-post of a verdict marker that skips
  the guard. The guarded tool is the **only** sanctioned emit path; a free-form raw post is a bypass,
  never an equivalent — a reviewer must not free-form the marker even when the body "looks clean."
- **The one escape hatch, itself guarded:** if a raw post is genuinely unavoidable, the body **MUST**
  first pass `pipeline-cli leak-guard scan-comment` (the standalone pre-post net #2823 added — reads
  the body on stdin / `--body-file`, exits non-zero on a machine-local path) **before** the post. A
  raw post whose body was never scanned is the forbidden case; a scanned one is the escape hatch.

This is the **enforcement complement** to #2823: #2823 hardened the guard *code* (`emissionDefect`'s
body-wide scan + the `leak-guard scan-comment` CLI); this mandate closes the emit-side hole by
forbidding the reviewer from routing around it — the two together are what actually close #2796. Each
review gate **references this rule as the single source** (it does not re-derive the *why* per skill).
Per #2393 the guard stays generic path-shape patterns, never a named-path deny-list.

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
- Post the body the required way — read it into `$BODY` and pass `-f body="$BODY"`;
  **never `gh api -f body=@file`**, which posts the literal path and leaks it publicly
  (see [Posting a comment body](#posting-a-comment-body--read-it-into-body-never-gh-api--f-bodyfile-the-local-path-leak)).

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
- Post the note the required way — read it into `$BODY` and pass `-f body="$BODY"`;
  **never `gh api -f body=@file`**, which posts the literal path and leaks it publicly
  (see [Posting a comment body](#posting-a-comment-body--read-it-into-body-never-gh-api--f-bodyfile-the-local-path-leak)).

---

## 4.5. The filing-provenance signal — the report footer, not GitHub authorship (ADR 0159)

This is the **single source** of the human-vs-agent-filed signal that triage's
never-auto-close protection consumes (`triage/SKILL.md` Step 5). The protection exists so
an autonomous agent — an audit or kill-sweep — never silently closes an issue a human
owns; that judgment needs a reliable filing-provenance signal, and this section defines it
(ADR [0159](https://github.com/kamp-us/phoenix/blob/main/.decisions/0159-never-auto-close-signal-is-the-report-footer.md)).

**GitHub issue authorship is NOT the signal.** Every issue filed through the `report` →
`triage` skills goes through the shared `usirin` gh token, so **an agent-filed issue and a
hand-typed one both show `author: usirin`** — the same shared-login degeneracy §7 / ADR
0115 removes for the claim marker. Keying off authorship over-protects the whole board
(everything reads as `usirin`) or silently bypasses the protection; it is unusable either
way. **Never consult authorship for this judgment.**

**The signal is the report footer.** The `report` skill emits a
`<sub>Filed by an agent · …</sub>` footer (`report/footer.sh`). The literal
**`Filed by an agent`** marker is the invariant tell — the footer's session/model/branch
fields are best-effort and often absent, so a **sparse footer is still a present footer**
(do not read a missing session/branch as "no footer").

**The canonical semantic:**

- **Footer ABSENT** — the issue was **hand-typed in the GitHub UI** ⇒ **human-owned ⇒
  PROTECTED**: never auto-close.
- **Footer PRESENT** — filed via the report skill, **including a human-invoked `/report`**
  ⇒ **raw INTAKE ⇒ auto-close-ELIGIBLE after confirmation.**
- **The confirmation step IS the guard** on the footer-present path — "eligible" is not
  "closed."

The footer means "**filed via the report skill**," **not** "agent intent": a
human-invoked `/report` also emits it. ADR 0159 settles the resulting fork by **taking
the confirmation step as the guard** and **rejecting a distinct human-invoked marker** — a
`/report` issue is intake by nature (meant to be triaged and closed), so human- and
agent-invoked `/report` are treated identically, and a human tracking their own thing
types it directly in the UI (no footer ⇒ protected). There is **no** separate
human-invoked footer token or env flag, and `footer.sh` is unchanged.

> **Provenance beyond the footer (unchanged).** A pipeline-made issue can carry the five
> report sections but **no** footer — e.g. a triage split child (look for `split from #N`).
> Such an issue is agent-made by provenance, not by footer; triage judges those by
> provenance the same as before (`triage/SKILL.md` Step 5). This section governs the
> footer signal itself; it does not narrow the "when in doubt, treat it as human" default
> the never-auto-close protection keeps.

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

**What the set governs — and where to read it.** It decides **merge authority**: who may merge a
PR that touches it. That is the only axis it governs; which gate *verifies* the PR is a separate
question (the callout below). The membership list is single-sourced in the `CONTROL_PLANE_RE`
const and printed, expanded, by **`pipeline-cli control-plane-paths --paths`** — run that rather
than read a copy, and never re-hard-code the list here or in a consumer. The regex those members
amount to is the canonical `CONTROL_PLANE_RE=` line in the next subsection.

**Deliberately OUT, recorded so each absence reads as a decision and not an oversight:** every
**nested** `.claude-plugin/` dir — the branch is root-anchored, and `kampus-pipeline`'s own
`plugin.json` is a genuine sibling gap to file rather than patch by hand (ADR
[0212](https://github.com/kamp-us/phoenix/blob/main/.decisions/0212-marketplace-manifest-is-control-plane.md)
Consequences); and the crew engine defs under `claude-plugins/pipeline-crew/agents/**`, which class
**has-skills** yet auto-ship on a `review-skill` PASS, because merge authority lives in `ship-it` and `shipper.md`
— both §CP, both re-verifying the §CP approval independently — so the worst a weakened crew def can
do is fail to bank (live founder ruling, re-affirmed 2026-07-24 on
[#3765](https://github.com/kamp-us/phoenix/issues/3765)). Do **not** widen `CONTROL_PLANE_RE` by
hand to cover either of them. ADR 0174's four operational skill dirs — `heal-ci`, `what-shipped`,
`doctor`, `wayfinder` — are **no longer** out: the whole `kampus-pipeline` skills tree is §CP, the
**directory** being the unit of coverage rather than the file type, so no naming convention has to
hold and the boundary cannot rot as skills are added (ADR 0227).

A PR touching **any** path in this set is **control plane**: `ship-it` never auto-merges it off a
gate verdict alone — it merges only once a `@kamp-us/control-plane` member approves at head, and
`ship-it` then enqueues it. Every widening of the boundary, and the reason for each, is an ADR —
0053, 0065, 0073, 0100, 0103, 0135, 0150, 0174, 0193, 0212, 0218, 0227 — plus the founder rulings on
[#3402](https://github.com/kamp-us/phoenix/issues/3402) and
[#4446](https://github.com/kamp-us/phoenix/issues/4446). Read them in `.decisions/`, where ADR
discovery is the CLAUDE.md contract; they are not restated here.
Everything else — `apps/**`,
**non**-guard `packages/**`, `.decisions/**` (**except a guard-touching ADR** — see the content
clause below), `.patterns/**`, every prose doc `*.md` (the
§DOC class), and every **non**-`kampus-pipeline` plugin's `skills/**` — is **non-blocking** and
auto-merges through its matching gate on a PASS. (This set governs *who merges*, not *which gate verifies* — a
code-root `*.md` is non-blocking here yet rides `review-code`, not `review-doc`, per §DOC.)

> **Merge-authority is the only axis this set governs.** It decides *who merges*
> (auto-merge vs. human), **not** *which gate verifies*. Routing is a separate axis: a
> gate-critical skill is **blocking for merge** yet still **`review-skill`-routed for its
> verdict** (ADR 0073 §4). Don't conflate the two — the blocking refusal short-circuits in
> `ship-it` Step 0 *before* the namespace/routing check, so both hold at once.

### The canonical matcher

Every consumer matches the set with this **one** anchored regex (POSIX ERE; the jq/`grep`
form below). The regex is **single-sourced** in the `CONTROL_PLANE_RE` const at
[`packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts`](https://github.com/kamp-us/phoenix/blob/main/packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts)
(issue #2761) — run `pipeline-cli control-plane-paths` to print it (or `--paths` for the expanded
§CP path set). Cite it; do **not** re-hard-code the path list. The one machine-readable
`CONTROL_PLANE_RE=` copy below is kept **byte-in-sync with that const** — guarded by `codeowners-cp`
and `validate-gate-path-drift.sh`, both of which fail closed on any divergence — and is retained
**only** because the live merge-deciding gates re-resolve it from THIS file on `origin/main` (#981);
that origin/main read is the anti-self-authorization property (a boundary-editing PR is classified
against MAIN's boundary, not its own edit) and must not move to an in-tree import.

```bash
# the single probe ship-it Step 0, review-code Step 2, review-doc Step 0, and review-skill
# Step 0 all use — kept byte-in-sync with the pipeline-cli const (issue #2761); the live gates
# re-resolve THIS line from origin/main (#981), so it stays here as the one un-importable copy:
CONTROL_PLANE_RE='^(\.claude|\.github)/|^\.claude-plugin/|^claude-plugins/kampus-pipeline/skills/|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/hooks(/|\.json$)|^packages/ci-required/|^packages/pipeline-cli/src/[^/]+$|^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/|^packages/pipeline-cli/src/tools/tracker/gh-io\.ts$|^biome\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\.lefthook)[^/]+$'
# The list this regex is matched against is a fallible READ, so it comes from §CPREAD's
# `cp_changed_files` (defined below) — never a bare `gh api … | grep` pipe. With pipefail off that
# pipe reports grep's status and discards gh's, so a failed read matches nothing and reads as "no §CP
# path touched" — fail-open at the definition of the boundary itself (#4216). §CPREAD owns the
# --paginate / streaming-jq / shape-assert rationale; read it there once, don't re-derive it here.
if ! cp_changed_files "$REPO" "$PR"; then
  echo "BLOCKING — §CP UNKNOWN (changed-file list unreadable; never 'no control-plane path')"
elif printf '%s\n' "$CP_FILES" | grep -Eq "$CONTROL_PLANE_RE"; then
  echo "BLOCKING — control plane (§CP — approval-gated)"
fi
```

**The §CP-deciding consumers resolve this line from `origin/main` at run time, not from the
copy embedded in their own skill body.** A skill runs against the **snapshot injected into the
agent's context at invoke time**, which can lag `origin/main` even when the on-disk copy in the
same worktree is current — so an agent on a pre-amendment snapshot once auto-merged a
now-control-plane PR the *current* boundary marks approval-gated (#981). The fix makes the
single source authoritative **at run time**, by either of two routes to the same read.
`review-code` Step 2 and `review-doc` Step 0 read the `CONTROL_PLANE_RE` line from this file on
`origin/main` (REST raw, `?ref=main`) inline. `ship-it` Step 0, `review-skill` Step 0,
`review-design` and `review-trivial` classify through `pipeline-cli cp-classify`, which performs
that same `?ref=main` read itself (`cp-classify/command.ts` `fetchLiveControlPlaneRe`). Either
route classifies against `origin/main`'s boundary and **fails closed** — every path treated as
control-plane, so the gate refuses — if the read can't be made, never falling back to the
possibly-stale snapshot. An inline reader carries an embedded `CONTROL_PLANE_RE='.'` fail-closed
default as its reference; a `cp-classify` consumer carries **no** embedded copy, because the verb
owns both the read and the fail-closed direction — **do not add one back**, which is the drift
this section exists to close. The one un-importable copy is the `CONTROL_PLANE_RE=` line above,
and it, not any consumer's, is `validate-gate-path-drift`'s lockstep target; neither is the live
decision source. This makes ADR 0073 §6's "single definition" hold across snapshot age, not just
on disk.

The **0052 instruction-trust set** (root `CLAUDE.md`, `.claude/**`, `.decisions/**`,
`.patterns/**`) is a *different* set — what a reviewer must never *load*, an isolation
concern, not a merge-blocking one. Keep them apart (review-code Step 2 spells out the
distinction). This section governs **only** the merge-blocking / control-plane set above.

### The guard-touching ADR predicate — a §CP membership test by CONTENT (ADR 0164)

The path matcher above is **necessary but not sufficient**: a `.decisions/**` ADR that
**relaxes, amends, or widens an exemption on a documented guard** is control-plane by *nature*
(it weakens the pipeline's own guardrails — the exact class §CP exists to hold for human
ratification), yet its **path** is indistinguishable from an ordinary ADR's. `.decisions/**` is
otherwise non-blocking (it auto-merges on a `review-doc` PASS), so a guard-relaxing ADR would
auto-ship past founder ratification with no mechanical hold — a control-plane fail-open (ADR
[0164](https://github.com/kamp-us/phoenix/blob/main/.decisions/0164-guard-relaxing-adr-cp-gate.md),
#2191).

So §CP membership has a **second, content-inferred clause** for `.decisions/**` files, alongside
the path `CONTROL_PLANE_RE`: a touched `.decisions/**` ADR whose **content cites or amends a
documented guard** is §CP. The signal is **inferred from the ADR prose, never an author-declared
tag** — an author-declared marker (`relaxes:` / `guard-change`) is self-defeating (the agent that
lacks the discipline to hold the ADR also won't add the tag; ADR 0164 MECHANISM). The predicate is
**deliberately conservative / fail-closed**: it over-matches on any guard-vocabulary mention
(routing a merely-guard-*citing* ADR to a cheap human approval) rather than risk missing a
guard-*relaxer* (which would auto-ship a weakened gate) — "you cannot relax a guard without naming
it," so a content probe over guard vocabulary catches the class an author tag would let slip. This
is the same fail-closed stance as §ZS / ADR 0092.

The predicate is **single-sourced** in the `GUARD_ADR_RE` const at
[`packages/pipeline-cli/src/gate-boundaries.ts`](https://github.com/kamp-us/phoenix/blob/main/packages/pipeline-cli/src/gate-boundaries.ts)
(issue #4401) — run `pipeline-cli control-plane-paths --boundary GUARD_ADR_RE` to print it. The one
canonical copy below is kept byte-in-sync with that const by `validate-gate-path-drift.sh`, which
also fails if a **second** `GUARD_ADR_RE=` line reappears: there used to be two, byte-identical, and
every consumer resolves first-occurrence-wins, so a corrective edit could land on the shadow and
appear to work. Cite this line; do **not** re-hard-code the vocabulary. The line is retained (rather
than replaced by an import) for the same reason `CONTROL_PLANE_RE`'s is — the live gates re-resolve
it from THIS file on `origin/main`, which is the anti-self-authorization property (#981).

```
GUARD_ADR_RE='guard|invariant|fail-closed|fail-open|fail closed|fail open|containment|control-plane|control plane|§cp|self-weakening|blocking set|adversarial review|must never|hard-gate|hard gate|enforcement|\bgat(e|es|ing|ed)\b|relax|loosen|weaken|soften|widen|broaden|waive|bypass|exempt|carve[ -]?out|opt[ -]?out'
```

The probe itself lives in [`shared/scripts/cp-guard-adr.sh`](shared/scripts/cp-guard-adr.sh) (§SHARED)
— it resolves `GUARD_ADR_RE` live from `origin/main`, non-triviality-asserts the strip (#4401), and
prints one `BLOCKING (…)` line per guard-touching or unreadable ADR:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cp-read.sh"; cp_changed_files "$REPO" "$PR" || CP_STATE=unknown   # §CPREAD owns the input
. "$KP_SHARED/cp-guard-adr.sh"                                                 # ADR-0164 content clause
```

A guard-touching ADR classifies **§CP for merge-authority** exactly like a path-§CP file:
`ship-it` STOPS at `awaiting control-plane approval` until a current-head `@kamp-us/control-plane`
approval is present (per POLICY, the founder's; ADR 0135). Its **verdict routing is unchanged** —
it is still doc-class, `review-doc`-verified (this set governs *who merges*, not *which gate
verifies*); the content clause adds only the merge-authority hold.

<a id="cpread"></a>
### §CPREAD. The changed-file list is a fallible READ — an unread list is UNKNOWN, never "no §CP path" (#4216)

Both clauses above match against **one input**: the PR's changed-file list. That input arrives over
the network, so it can fail to arrive — and the shape every §CP site reached for
(`gh api --paginate … --jq '.[].filename' | grep -E "$CONTROL_PLANE_RE" || true`) resolved a failed
read to the **empty string**, which the surrounding control flow read as *"no control-plane path
touched"*. That is fail-**open** on the repo's only human-judgment gate (ADR 0135): a genuinely-§CP
PR classifies ordinary and skips the control-plane approval. It is the recurring
read-failed-collapsed-into-a-definite-answer class (#3715, #4108, #4171, #4189, #4191, #4204).

**The rule: a read that could not execute resolves to UNKNOWN and holds as §CP.** Three properties
make that true, each verified against the live API rather than assumed (#4216):

1. **The exit status is the discriminator — capture, check, *then* pipe.** `pipefail` is off in the
   agent shell, so `gh … | grep … || true` reports `grep`'s status and **discards `gh`'s**. The
   `|| true` was reasoned about one producer of an empty result (no match is `grep` exit 1, #725)
   and was blind to the other (the read itself dying). Observed: the 404 pipeline exits **0** with
   an empty capture.
2. **The error body arrives on STDOUT.** A failed `gh api --paginate … --jq` writes
   `{"message":"Not Found",…}` to **stdout** (exit 1), so an unchecked capture hands the §CP regex —
   or `cp-classify` — an *error document* to classify as if it were a file list. Under a live
   boundary regex that document matches nothing and the PR reads ordinary. The failure branch must
   therefore **discard the payload**, not just test it.
3. **Shape first, then interpret.** The jq guard asserts the page is an **array** before reading
   `.filename`, so a 200-with-an-unexpected-body cannot be iterated as though it were a file list —
   the bare non-empty test that once declared two unapproved §CP PRs approved (#3715).

Plus §ZS (ADR [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)):
**emit the scanned scope**, and treat **zero scope as a failed read** — a PR always changes ≥1 file,
so a zero-length list is never a valid "clean" state. "Read failed" and "read fine, matched nothing"
are logged **distinctly**: same outcome, different facts, and collapsing them makes an outage look
like a clean negative.

This is the **one** hardened read, and it binds **every** §CP site — *including the two blocks
**above*** (the canonical matcher and the ADR content clause), which is why each of them reads
`$CP_FILES` rather than piping `gh` straight into `grep`. A contract that exempts its own definition
block is exactly how byte-identical defective copies spread from it, so the scope here is *every*
site in this file and in every skill that cites it — not merely the ones below.

`cp_changed_files` (the file list, setting `CP_FILES` + `CP_FILES_N`) and `cp_head_sha` (the ref, setting
`CP_HEAD_SHA`) both live in [`shared/scripts/cp-read.sh`](shared/scripts/cp-read.sh) (§SHARED), with the
`--paginate` + streaming-`--jq` and dead-guard rationale carried in the script's own comments. Consumers
source it and branch on the **return status**, resolving a failure toward §CP:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cp-read.sh"
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ hold as §CP (never `not-control-plane`)
fi
```

#### §CPREAD-APPROVAL. The three reads the ADR-0175 discharge makes — UNKNOWN is not a cardinality (#4223)

Classifying a PR as §CP is only half the boundary; **discharging** it (the ADR-0175 approval gate in
[`ship-it`](ship-it/SKILL.md)) makes three more network reads — the `control-plane` team roster, the
PR author, and a per-approver team-membership probe. They take the same three properties, plus a
fourth that the file-list read does not need:

4. **A failed read and a genuinely-empty answer are different FACTS with the same non-firing
   outcome — never collapse them.** For the roster they are distinguishable by **content**: a failed
   read is a one-line JSON error document, an empty team is an empty stream. So the discriminator is
   a **shape check**, not a bare `|| exit`. Measured (#4223): an unreadable roster leaves a ~120-byte
   error blob on **one** line, so a line-counting cardinality computes **N=1 on a phantom member
   whose login is an error body** — `cp-cardinality`'s `n === 0` "the team is empty" branch is never
   reached, and anyone hardening *that* branch hardens a branch this failure cannot enter. An
   unresolved roster must therefore resolve to **UNKNOWN and stop under its own reason line**, never
   to a cardinality and never to "the team is empty".

   **Read that at its measured size: a correctness and observability defect, not a privilege
   escalation.** The phantom-member `N=1` lands on `single-owner-other`, which discharges on the
   **identical** `nonAuthorApprovalAtHead` signal as the `multi-member` branch it displaces — so it
   cannot lower an approval bar, and a 30-day audit of 1194 merged PRs (356 of them §CP) found no
   case where it did. What it costs is a true answer: the gate reports an outage as a finding about
   the team's shape.

The three reads — `cp_team_roster` (sets `CP_MEMBERS` + `CP_MEMBERS_N`), `cp_pr_author` (sets
`CP_PR_AUTHOR`), `cp_team_membership` (sets `CP_MEMBERSHIP` to a state or `absent`) — sit alongside the
two above in [`shared/scripts/cp-read.sh`](shared/scripts/cp-read.sh) (§SHARED); each carries its own
shape-assert rationale in-script:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cp-read.sh"
cp_team_roster "$ORG"          || CP_ROSTER_STATE=unknown   # NEVER a cardinality, never "the team is empty"
cp_pr_author "$REPO" "$PR"     || CP_AUTHOR_STATE=unknown   # un-skipping the author would count a self-approval
cp_team_membership "$ORG" "$L" || CP_MEMBER_STATE=unknown   # 404 is definite; anything else is UNKNOWN
```

Consumers of these three resolve a failure to **UNKNOWN and stop under a reason line that names the
read that failed** — never under `awaiting control-plane approval`, which asserts a fact about a
human that no one established. Same outcome as a genuine wait, different fact; reporting the first as
the second sends an operator to debug a person instead of an outage.

### A path-only §CP answer is NEVER authoritative — use `cp-classify` (#4161)

The two clauses above are **independent sources** of §CP membership, and `CONTROL_PLANE_RE` has
**no `.decisions/` clause** — so a path-only test classifies *every* ADR non-§CP. A guard-touching
ADR is therefore §CP with **zero path matches** (live: PR #4134, both files `.decisions/**`; the
shipper caught it only by running the content probe). The failure is **silent and fail-open**: the
guard-relaxing change reads as ordinary product work and escapes the human §CP approval entirely,
rather than erroring.

**The rule: a bare "no path matched" is not a verdict.** Every consumer that needs "is this §CP?"
runs the shared entry point, which cannot hand back a fail-open no:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cp-classify-entry.sh"   # §SHARED: §CPREAD input → cp-classify → $CP_STATE, held on anything but not-control-plane
```

[`shared/scripts/cp-classify-entry.sh`](shared/scripts/cp-classify-entry.sh) leaves `$CP_STATE` in the
caller's shell and prints `BLOCKING (§CP state '…')` on every value except the one proven-ordinary
`not-control-plane` — including the empty string a failed invocation yields. It takes its input from
§CPREAD's `cp_changed_files`, never a bare `gh api … |` pipe: with `pipefail` off, a failed read pipes
its stdout **error body** into the verb, which sees one non-`.decisions/` "path", matches no §CP clause,
and answers `not-control-plane` — a fail-open at the very entry point that exists to prevent one
(#4216).

| stdout | meaning | exit |
| --- | --- | --- |
| `control-plane` | a path matched — authoritative §CP, BLOCKING | 0 |
| `content-undetermined` | no path matched, but `.decisions/**` files are present — **an obligation, not a verdict**: probe each with `guard-content-probe` at the PR head before claiming ordinary | 0 |
| `not-control-plane` | path clear **and** no `.decisions/**` file, so the content clause has nothing left to decide — the one proven-ordinary verdict | 3 |
| `unknown` | the classification could not be made (unresolvable / uncompilable boundary, empty file set) — treat as §CP and hold | 0 |

`unknown` is its own state on purpose: a read that **failed** and a change that is **genuinely
non-§CP** are different facts, and collapsing them is the recurring fail-open defect class here
(#3715, #4108, #4171, #4191). `content-undetermined` resolves through the **existing** ADR-0164
probe unchanged, so this widens no over-match (#2617).

**The exit code discriminates the four states only once the verb has RUN — so a consumer asserts
on the stdout state word, never on a bare non-zero.** Both naive exit-status shapes are **UNSAFE
and must not be used**: `… || ordinary` fires on an effect-cli usage error (exit 1, help text on
stdout, no state word) and on a missing binary (exit 127) exactly as it does on the real verdict,
routing a §CP change to the ordinary branch; `… && echo BLOCKING` simply emits nothing when the
verb never ran, so the BLOCKING line the caller relied on never appears. Both fail **open**, and a
`pipeline-cli` that does not resolve is live here — a bare `pipeline-cli` exits 127 when the shim
is off `PATH`. That is why `not-control-plane` carries its own exit code **3**, which neither a
usage error (1), a missing binary (127), nor an unread stdin (4, #3924) produces: an exact
`[ "$rc" -eq 3 ]` is proof, `[ "$rc" -ne 0 ]` is not. Every wired consumer below uses the
state-word form above; a new one that does not is not wired correctly.

#### The classification-site register

Every site that decides §CP membership, and which sources it consults. A new consumer joins this
table or it does not ship.

| site | sources | note |
| --- | --- | --- |
| `ship-it` Step 0 | `cp-classify` (path + content) | the merge-deciding gate; was ~500 lines of hand-rolled boundary bash — the last merge-deciding site to migrate (#4405). The verb re-resolves the boundary from `origin/main` itself, so the #981 run-time re-derivation is preserved, not traded for a compile-time import |
| `review-code` Step 2 | path + content | |
| `review-doc` Step 0 | path + content | |
| `review-design` | `cp-classify` (path + content) | was path-only |
| `review-skill` Step 0 | `cp-classify` (path + content) | was path-only |
| `review-trivial` | `cp-classify` (path + content) | was path-only; routes to the lighter gate, so a fail-open here under-gates |
| `trivial-diff` | path + content | bound 3; shares the content-clause scope with `cp-classify` |
| `codeowners-cp` | **path only — deliberate, not a defect** | it generates `.github/CODEOWNERS`, and GitHub matches CODEOWNERS on **paths**; the format structurally cannot express a content predicate. The content clause is enforced at the gates above instead, which is where a merge is actually decided. |
| the crew driver (EM) | *classifies §CP nowhere today* | when it does, it uses `cp-classify` — tracked by #3416, which must not be built twice |

The boundary stays single-sourced on both axes: `CONTROL_PLANE_RE` in the pipeline-cli const
(#2761), `GUARD_ADR_RE` in this file, and the content clause's **scope** (`.decisions/**`) once in
`cp-classify`'s core. No consumer re-declares any of the three.

**Every row's *input* is §CPREAD** — the register says which *sources* a site consults; §CPREAD is
how it obtains the file list those sources are evaluated against. A site that hardens one clause but
reads its input unchecked is still fail-open, because a failed read blinds **both** clauses at once
(#4216). `codeowners-cp` is the one exception on this axis too: it runs over the boundary regex, not
over a PR's changed files, so it has no such read.

---

## DOC. The doc-class / review-doc surface — one canonical definition

`review-doc` and the actors that cite it (`ship-it` Step 0, `write-code`, this file's §6
marker prose) all need the *same* answer to a second question — **is this `*.md` a doc
artifact, or code-adjacent markdown that rides `review-code`?** The doc class was once
described loosely as "prose `*.md` outside `.claude/`/`.github/`", which over-matched a
**code-root** `*.md` (a `packages/**`/`apps/**` README) into the doc class even though no
doc gate ever runs on it — the #542/#650 deadlock, where `ship-it` demanded a
`review-doc: PASS` that can never exist because `review-doc` routes the whole `apps/**`/
`packages/**` tree (README included) to `review-code` (PR #655). This section is the
**single source of the doc class**, so every consumer cites *one* definition and the
loose phrasing can't re-seed that over-match (mirroring §CP's single-sourcing of the
control-plane set).

**The doc class is, exactly — a `*.md` (or `.decisions`/`.patterns` knowledge file)
that is:**

- under `.decisions/**`, `.patterns/**`, or `docs/**`; **or**
- a **root / top-level** prose doc — `README.md`, `CLAUDE.md`, a top-level `*.md`;

**and is NOT** under any of the carved-out roots, in this precedence order:

- **control plane** (`.claude/**`, `.github/**`, a gate-critical skill — the §CP set);
- **`skills/**` and `agents/**`** — behavioral artifacts, `review-skill`'s class, carved out
  *before* the `.md` test (ADR [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md);
  agents added by ADR [0150](https://github.com/kamp-us/phoenix/blob/main/.decisions/0150-control-plane-covers-pipeline-agent-defs.md));
- the **code roots `apps/**`, `packages/**`, and `infra/**`** — a code/app-internal `*.md` (a
  package or app README, CHANGELOG, …) rides the `review-code` PASS its tree already needs, and is
  **never** the doc class. `infra/**` is a real standalone-stack code root (ADR
  [0057](https://github.com/kamp-us/phoenix/blob/main/.decisions/0057-one-worker-per-app.md)), so a
  package README under an `infra/**` stack rides its code artifact exactly as an `apps`/`packages`
  README does.
- **`.glossary/**`** — the repo-owned domain vocabulary (`.glossary/TERMS.md`, `LANGUAGE.md`;
  a 4th committed doc surface, ADR [0099](https://github.com/kamp-us/phoenix/blob/main/.decisions/0099-glossary-surface-audit-skill-emits-issues.md)).
  `review-code` Step 3c **reads + enforces** this contract (a new-surface code PR must touch
  `.glossary/TERMS.md` — the [#912](https://github.com/kamp-us/phoenix/issues/912) freshness gate),
  so the gate that owns the glossary is `review-code`, not `review-doc` — the glossary rides the
  `review-code` PASS, exactly the #644 package-README precedent. Were it left in the doc class,
  #912's mandatory `.glossary/TERMS.md` touch would make every new-surface **code** PR mixed
  code+doc and demand a `review-doc` PASS that the pipeline never routes (the #919 deadlock).

This is **exactly `review-doc`'s verification surface**: a present doc class therefore
always has a *reachable* gate. The code-class carve-out names the roots **`apps`,
`packages`**, plus **`.glossary`** and **`infra`** — and `ship-it` Step 0's has-code probe
(`^(apps|packages|\.glossary|infra)/`) names the **same** roots as the docs-exclusion
(`grep -Ev '^(claude-plugins|apps|packages|\.glossary|infra)/'`), so a `.glossary/**` or
`infra/**` path classes **has-code** (riding the `review-code` PASS) and is dropped from docs **in
lockstep** — prose and both probes name one boundary and can't drift (the #663
has-code/docs-exclusion agreement invariant, extended to `.glossary/**` by #919 and to `infra/**`
standalone stacks (ADR 0057) by #1987).

The canonical probe both `ship-it` Step 0 and `review-doc` Step 0 run — carve out
control-plane, then `skills/**`, then the code roots + `.glossary/**` + `infra/**`, *then* test for a doc path.
The two regexes it uses — the carve-out `HAS_DOCS_EXCLUDE_RE` and the doc-path `HAS_DOCS_RE` — are
single-sourced as canonical named `_RE=` lines in [§CLASS](#class-the-artifact-class-probes--one-canonical-definition)
below (alongside `HAS_CODE_RE`/`HAS_SKILLS_RE`), re-resolved from `origin/main`:

```bash
# docs class = review-doc's surface: a .md/knowledge file outside control-plane, skills/**,
# the code roots apps/**/packages/**/infra/**, AND .glossary/** (#542/#650/#663/#919/#1987). Cite this; don't re-derive it loosely.
echo "$FILES" | grep -Ev "$HAS_DOCS_EXCLUDE_RE" | grep -Eq "$HAS_DOCS_RE" && echo "has-docs"   # HAS_DOCS_* single-sourced in §CLASS
```

A code-root `*.md` is **not** weakened by this carve-out — it is gated harder, by
`review-code` over its whole tree, not skipped. Only the *class label* moves: from a
phantom doc class with no reachable gate to the code class that already gates it.

---

## CLASS. The artifact-class probes — one canonical definition

`ship-it` Step 0 (which gate(s) a PR needs before merge) and the `reviewer` agent (which
gate(s) to dispatch in a review pass) both classify a PR's changed-file set into the
**artifact classes** — **has-code / has-docs / has-skills**. Both must reach the *same*
answer, or the review stage gates one class while `ship-it` demands another: the multi-class
gap where a PR carrying one class's PASS reaches `ship-it` and fail-closes on an ungated
sibling class, a late stall (#2383; PR #2378 touched docs+skills+code, reached `ship-it` with
only `review-doc: PASS`).

So these probes are **single-sourced** in
[`packages/pipeline-cli/src/gate-boundaries.ts`](https://github.com/kamp-us/phoenix/blob/main/packages/pipeline-cli/src/gate-boundaries.ts)
(issue #4401), with the canonical named `_RE=` lines below kept byte-in-sync with those consts by
`validate-gate-path-drift.sh` — the same arrangement `CONTROL_PLANE_RE`/`GUARD_ADR_RE` (§CP) and
`UI_RE` (`ship-it/SKILL.md`) use, and for the same reason: the lines stay because the live consumers
re-resolve them from `origin/main` (#981), the consts exist so a reflowed or emptied line is a red
test rather than a changed gate decision. A third inline copy in `reviewer.md` is the exact drift
`#375`/`#981`/`#2341` fought — the class probes were previously inline grep literals in `ship-it`
Step 0 *only*, with no reusable line for the reviewer to consume:

```bash
HAS_CODE_RE='^(apps|packages|\.glossary|infra)/'
HAS_SKILLS_RE='^claude-plugins/[^/]+/(skills|agents)/|^\.claude-plugin/'
HAS_DOCS_EXCLUDE_RE='^(claude-plugins|apps|packages|\.glossary|infra)/'
HAS_DOCS_RE='^(\.decisions|\.patterns)/|\.md$'
```

The boundary each line draws is **not re-derived here** — it is §DOC's, above: `HAS_CODE_RE`
names the code roots (`apps`/`packages`/`.glossary`/`infra`, the #663/#919/#1987 has-code set),
`HAS_SKILLS_RE` the plugin behavioral-artifact surface — **any** plugin's `skills/**`/`agents/**`
(the plugin-name is `[^/]+`, not the `kampus-pipeline` literal) **plus the `.claude-plugin/**`
plugin/marketplace manifest** that declares that surface (ADR 0073/0150; #2387) — and the
two `HAS_DOCS_*` lines are the carve-then-test docs probe. `HAS_CODE_RE` and `HAS_DOCS_EXCLUDE_RE`
name the **same** code roots (the has-code/docs-exclusion agreement invariant) and must move in
lockstep — keep them adjacent so a root added to one is added to the other.

`HAS_SKILLS_RE`'s two additions close the **#663 neither-class gap** for the plugin surface (#2387):
a PR touching only a **non-`kampus-pipeline`** plugin's `agents/**`/`skills/**` (e.g. the
`pipeline-crew` crew defs) or only the `.claude-plugin/**` manifest (`plugin.json`,
`marketplace.json`) previously matched **no** class — so `ship-it` Step 0 demanded no gate and it
reached merge un-reviewed. Both now class **has-skills** and ride the `review-skill` gate: the
manifest surface *declares* the plugin's skill/agent artifacts (and is the drift-check `source`
`validate-gate-path-drift.sh` locks), so it belongs to the same behavioral-artifact class and gate
as the artifacts it manifests — no new class or gate is invented. This is **only** the review-class
axis: `CONTROL_PLANE_RE` (§CP, who-merges) is a **separate** regex and is **untouched**, so a crew
plugin's `agents/**` gains a `review-skill` gate yet still **auto-ships** on PASS (the founder #2342
ruling — extras don't block — **re-affirmed 2026-07-24 on #3765** on the threat-modeled containment
basis recorded in the crew-engine-defs clause of the §CP **Deliberately OUT** paragraph above; the class fix and the
§CP ruling compose).

**Both consumers re-resolve these lines from `origin/main` at run time** (REST raw, `?ref=main`
— the #981 idiom, generalized from `CONTROL_PLANE_RE`/`UI_RE` to the class probes), never trusting
the injected skill snapshot, which can lag `origin/main` even when the on-disk copy is current.
The re-resolution is **fail-closed**: an unreadable source ⇒ **dispatch the gate** (never silently
skip a class) — `HAS_CODE_RE`/`HAS_SKILLS_RE`/`HAS_DOCS_RE` default to `.` (every path matches),
`HAS_DOCS_EXCLUDE_RE` defaults to a never-match sentinel (`$^`, so the carve-out excludes nothing
and every path falls through to the doc test). This is the same stance as §CP's fail-closed
`CONTROL_PLANE_RE='.'` and `UI_RE`'s fail-closed `has-ui`:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/class-probe-resolve.sh"   # §SHARED: leaves the four live HAS_*_RE in this shell
```

[`shared/scripts/class-probe-resolve.sh`](shared/scripts/class-probe-resolve.sh) makes the single
`?ref=main` raw read, strips each canonical `_RE=` line, and runs the **non-triviality assert**
(`accept_re`, #4401) before any caller gates on the result: a strip that silently did not strip, or
yielded nothing, still *compiles* — `grep -E ""` matches every path and `grep -Ev ""` matches none,
both at exit 0 — so the polarity, not the error, would decide whether the miss is loud or silent.
Absence was already handled; triviality was not.

### The doc/vocab-surface predicate — the issueless allowance's axis (`DOC_VOCAB_*_RE`)

The three gates' Step 1 no-linked-issue rules ask a **different question** from the class probes
above: not *which gate verifies this path* but *is a missing `Fixes #N` legitimate here*. The two
axes disagree on exactly one surface — `.glossary/**` classes **has-code** (#919, so `review-code`
Step 3c owns the glossary-freshness contract) yet is a **conversation-authored vocabulary** surface
whose canonical PR — an ADR co-locating the `.glossary/**` row it coins — is issueless *by design*
(ADR [0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md),
extended to the code lane by ADR
[0184](https://github.com/kamp-us/phoenix/blob/main/.decisions/0184-review-code-issueless-carve-out.md)).
Keying the issueless allowance on the *class* therefore false-refuses that PR — the #3953
divergence, where `review-doc` Step 1 hard-stopped a shape `ship-it` Step 1 and `review-code`
Step 1 both bless by name.

So the allowance keys on the **surface**, its own carve-then-test pair — adjacent to the class
probes, deliberately **not** one of them, and single-sourced in `gate-boundaries.ts` alongside them
(`pipeline-cli control-plane-paths --boundary DOC_VOCAB_SURFACE_RE`):

```bash
DOC_VOCAB_EXCLUDE_RE='^(apps|packages|infra|claude-plugins)/'
DOC_VOCAB_SURFACE_RE='^(\.decisions|\.patterns|\.glossary)/|\.md$'
```

A path is a **doc/vocab surface** iff it does **not** match `DOC_VOCAB_EXCLUDE_RE` (the real code
roots + skills source) **and** matches `DOC_VOCAB_SURFACE_RE`. A PR is **doc/vocab-surface-only**
iff its changed-file set is non-empty and **every** path is one. `DOC_VOCAB_EXCLUDE_RE` omits
`.glossary` where `HAS_DOCS_EXCLUDE_RE` excludes it — that is the surface-vs-class distinction, not
a drift between the two lines, so the has-code/docs-exclusion lockstep invariant above does **not**
extend to this pair.

The predicate is **narrow by construction**, which is what keeps it from becoming a general
"missing issue is fine" escape: a code-root `*.md` (`apps/web/README.md`) is excluded *before* the
`.md$` test, and an unclassified root file (`biome.jsonc`, `turbo.json`) fails the surface test — so
a PR that touches code and merely forgot its issue link still refuses. Run it through the shared
verb rather than hand-rolling the greps — `pipeline-cli class-probe doc-vocab-surface-only` (exit 0
⇒ doc/vocab-surface-only, non-zero ⇒ not). Re-resolution fails closed **toward refusal**, the
mirror image of the class probes' over-dispatch: `DOC_VOCAB_EXCLUDE_RE` defaults to `.` (every path
excluded) and `DOC_VOCAB_SURFACE_RE` to `$^` (no path is a surface), and zero input resolves *not*
surface-only (ADR 0092) — an unreadable source can never **grant** the allowance.

**Consumers.** `review-doc` Step 1 consumes this line directly. `ship-it` Step 1 and `review-code`
Step 1 state the same boundary in prose today (each scoped to its own lane); until they are
converted to cite it, this pair is the definition they must agree with.

---

**No-class fail-closed — a non-empty diff can never require zero gates (#2765).** A changed file
that matches **none** of the three class probes above — root-level executable build/lint tooling
outside the code roots (`biome-plugins/**`, `biome.jsonc`, `turbo.json`, `pnpm-workspace.yaml`, a
root `tsconfig`) — used to leave the diff spanning **no** class, so `ship-it` required **zero**
review verdicts and the PR could merge un-gated (PR #2760's GritQL biome plugins shipped safe only
by carrying an *unrequired* `review-code` PASS). That is a fail-**open** in the gate itself. The
fix is the same ADR 0092 fail-closed idiom the `reresolve_re` defaults use: **any unclassified
changed file rides `has-code` → `review-code`** (the general logic gate), so a non-empty diff always
requires at least one gate. This is **not** a fourth class or a widened `HAS_CODE_RE` (single-sourcing
the whole regex is the separate #2761) — it is the fail-closed *default* of the existing classes,
implemented once in the shared core (`pipeline-cli class-probe`, which `ship-it` Step 0 and the
reviewer fan both run) so `required == dispatched` holds. An **empty** diff still spans no class —
the default fires only on a real unclassified file, never on nothing. Note the §CP interaction (which
this fix leaves untouched): a no-class PR that is *also* control-plane already stops at human merge
via `CONTROL_PLANE_RE`; this closes the gap for the no-class PR that is **not** control-plane.

`review-design`/`has-ui` is **additive** and stays single-sourced in `ship-it/SKILL.md`'s
`UI_RE=` (dispatched alongside whatever class gate(s) fire, never as a class of its own — see the
`ui_reresolve` invariant in `reviewer.md`); the `HAS_*` lines above cover the three mutually-inclusive
verdict classes. `pipeline-cli class-probe classify` folds the additive gate in — it parses `UI_RE`
from that same single source and appends `has-ui` (`--namespaces`: `review-design`) — so the reviewer
fan dispatches review-design off the same deterministic probe, never an eyeball that skips a non-visual
`apps/web/src/*.ts` and deadlocks ship-it on a phantom-empty `review-design` namespace (#2485/#2483).

---

## ZS. Zero-scope = fail — the gate-self-assertion invariant (ADR 0092)

Every gate's signature failure mode is the **silent no-op**: a gate keyed off an upstream
marker nobody ever sets runs on every event, fires on **none**, and reads **PASS forever** —
green because it never matched, not because the work is safe. The class lives at the
meta-layer (`review-code`'s flag-gating check that always reads `none`, `ship-it`'s
dark-merge branch off the same unset marker, the CI cycle test that only proves the absent
path, the epic-ledger validator that "passes" a childless epic). This section states the
fix **once** so every gate cites *one* definition and the per-gate retrofits don't each
re-derive it (the §CP/§DOC single-sourcing discipline, applied to the fail-closed invariant;
ADR [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)).

**The invariant — every gate's enforcement step MUST, on every run:**

1. **Emit what it scanned** — the file count, the matched paths, the set of events
   considered. "What did this gate actually look at" is answerable from its output, so a
   gate that quietly stopped matching is visible immediately rather than reading green.
2. **FAIL CLOSED when a *relevant* input yields zero matches.** "Scanned nothing" on an
   input the gate *was supposed to act on* is a **FAIL**, never a silent PASS. The design
   bias flips from "default PASS, fail on detect" to **"default FAIL, pass on positive
   evidence of scope."**
3. **Express a legitimately-empty scope as an explicit *not-applicable* skip** — never an
   accidental zero-match PASS. A docs-only PR hitting a code gate, an epic that correctly
   has no children to flip on this pass: the gate states *not applicable to this input* and
   that skip is **distinct** from a zero-match FAIL. The distinction is the whole point —
   #2 catches the gate that *should* have matched and didn't; #3 is the gate that *correctly*
   had nothing in its surface. A gate that can't tell them apart is itself a silent no-op.

**The reading stance** (mirrors §CP/§DOC): a gate is *relevant* to an input when the input
falls in the gate's surface (a code gate ↔ a PR with code files; the epic-ledger floor ↔ an
epic that declares children). Relevant-but-zero-match ⇒ FAIL (#2); out-of-surface ⇒
not-applicable skip (#3). The skip is a first-class, correct outcome — the same
graceful-absence shape the cycle-doc probe (§1) and the milestone default (none) already use.

A gate that adopts this convention is **self-asserting**: its own output proves it fired,
so it can't rot into a no-op undetected. **A gate that cannot fail is worse than no gate**
(ADR 0092) — this invariant is how a gate earns trust by demonstrating scope, not by
defaulting green.

---

## RO. Read-only on git working state — the gate-never-mutates invariant (#639)

Every review/ship gate runs in a checkout it does **not** own — often the owner's **live,
running dev-server checkout** — so a working-tree mutation there can silently destroy
uncommitted work, exactly the data loss a verification step must never cause (a `review-doc`
agent once ran `git stash pop` then `git reset --hard HEAD` in the primary checkout; no harm
that time, pure luck). This section states the rule **once** so every gate cites *one*
definition rather than re-deriving the prohibition in five verbatim copies — the §CP/§DOC/§ZS
single-sourcing discipline, applied to working-tree safety (closing the #375-class copy drift
those copies would otherwise re-seed).

**The invariant — a review/ship run MUST never mutate the launched/shared checkout's git
state:**

- **Never run `git checkout` / `git switch` / `git reset` / `git stash` / `git clean` /
  `git merge` / `git pull` / `git rebase`** — nor `gh pr checkout` — in the checkout you were
  launched in. No branch switch, no working-tree mutation, ever.
- **Read head and base read-only.** Drive the diff/file reads over `gh api` / `gh pr diff`,
  or fetch the head into a per-run ref and read off *that ref* without checking it out:
  `git fetch origin pull/$PR/head:$PR_REF` then `git show "$PR_REF:<path>"` /
  `git grep <pattern> $PR_REF`. `git fetch` and `git update-ref -d` (your own per-run ref)
  are fine — they don't touch the working tree.
- **Any materialized tree is an isolated throwaway worktree, never the primary checkout** —
  `git worktree add "$(mktemp -d)/…" "$PR_REF"`, torn down with `git worktree prune` after.
  A tree the gate exclusively owns, never the checkout it was launched in.

This is non-negotiable and orthogonal to the 0052/0067 config-isolation split: that split
keeps the head's *instructions* out of a reviewer's path; this keeps *the gate's* git ops out
of the owner's working tree. A gate that needs a materialized head has the per-run-ref +
throwaway-worktree mechanism above; it never reaches for the launched checkout.

### RO-iso. `iso_preflight` — refuse head-materialization from the PRIMARY checkout when isolation was expected (ADR 0172)

The §RO throwaway-worktree/per-run-ref materialization is safe **only** when the gate's git
ops land somewhere other than the shared **primary** checkout's working state. The
[#2452](https://github.com/kamp-us/phoenix/issues/2452)/[#2453](https://github.com/kamp-us/phoenix/issues/2453)
detach proved the residual hole: a review/ship gate spawned `isolation:worktree` but dropped —
by the [#2440](https://github.com/kamp-us/phoenix/issues/2440) harness no-op — into the primary
checkout with `$WORKTREE_ROOT` unset ran its head-materialization there. That no-op *also*
disarms the entire `$WORKTREE_ROOT`-keyed repo-side `worktree-guard`
(`packages/pipeline-cli/src/tools/worktree-guard/`), so nothing loudly refused.

`iso_preflight <surface>` is the **single-sourced** reviewer/shipper sibling of `write-code`'s
Step-4 `wt_preflight` (ADR [0172](https://github.com/kamp-us/phoenix/blob/main/.decisions/0172-write-code-fails-loud-when-expected-worktree-isolation-is-absent.md),
#2443/#2446): the **same** `git-dir == common-dir` primary-checkout detection and the **same**
isolation-expected fork, defined **once here** so the three head-materializing gates
(`review-code`, `review-trivial`, `ship-it`) share one contract rather than drifting three
copies apart. Each gate runs it — `iso_preflight <surface> || exit 1` — **before** its first
head fetch / `git worktree add`:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/iso-preflight.sh"        # §SHARED: read-only, git rev-parse only, safe to re-run
iso_preflight review-code || exit 1    # BEFORE the first head fetch / `git worktree add`
```

[`shared/scripts/iso-preflight.sh`](shared/scripts/iso-preflight.sh) carries the detection and its
three isolation-expected clauses: the agent-type name, a set `$WORKTREE_ROOT`, and the
env-independent corroboration (any agent-context run sitting on the primary checkout — the clause
that catches a nested/renamed spawn whose inherited agent-type string names no role, #3406). The LOUD
refusal fires on the **agent type alone**, so the #2440 no-op that also disarms the
`$WORKTREE_ROOT`-keyed repo-side `worktree-guard` still trips this preflight as the sole surviving
layer.

The fork is what keeps this **non-breaking for a legitimate standalone gate**: §RO explicitly
runs a gate "in a checkout it does not own — often the owner's live checkout," and that
standalone-on-primary mode stays allowed (the gate's materialization is throwaway-only). The
LOUD stop fires **only** for an isolation-expected pipeline spawn that mis-landed on the primary
checkout — the exact #2440/#2453 condition. `write-code`'s Step-4 `wt_preflight` is the stricter
sibling (it *always* expects isolation and additionally must branch the session tree, so it also
refuses the standalone-on-primary case via its Non-isolated fallback); it is a deliberate,
documented specialization of this same contract, not a fourth drifting copy.

---

## SHARED. The extracted shared scripts — one resolution, sourced not pasted (epic #4435)

This contract's recipes are **sourced scripts**, not fenced prose an agent re-types. They live under
[`shared/scripts/`](shared/scripts/) (`.sh`, at any depth under `skills/` — the extension is what puts
them inside `CONTROL_PLANE_RE` and the `/claude-plugins/kampus-pipeline/skills/**/*.sh` CODEOWNERS row,
so a change to one needs a human approval; #4446), beside the cross-script state lib
[`shared/lib/common.sh`](shared/lib/common.sh).

**Why sourced rather than fenced.** Each agent shell invocation is a fresh process, so a variable set
in one fenced block is gone by the next — every recipe that produced `$CP_FILES`, `$GUARD_ADR_RE` or
`$RUN_SCRATCH` for a *later* block was un-runnable as written, and each agent hand-stitched around it
differently. A script also runs as **one** permitted command, so the worktree guard never parses its
internals (#4427). The prose keeps the *why*; the script carries the shell (founder ruling on #4435).

**The one resolution — re-run it per block, exactly like §CLI's `PCLI`.** `$KP_SHARED` is a shell
variable, so it does not survive between an agent's separate Bash calls; never cache it to a file (§SP):

```bash
# §SHARED — resolve the extracted-script dir. Same two tiers as §CLI's shim: $CLAUDE_PLUGIN_ROOT
# covers a foreign consumer install, the git-toplevel fallback covers this repo from ANY cwd, in the
# primary checkout AND in an agent worktree.
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
```

Then `. "$KP_SHARED/<name>.sh"` to get its functions/variables into your shell, or
`bash "$KP_SHARED/<name>.sh" …` when you only need its stdout. Each script's header states which of the
two it is and which caller variables it reads.

**What did NOT move, and why.** The nine column-0 boundary canonicals stay in *this* file, at column 0,
exactly once each: `validate-gate-path-drift.sh` asserts that, and the live gates re-resolve them from
this file on `origin/main` — the #981 anti-self-authorization property. So does the §CLI `PCLI=`
preamble and the §Target-repo `REPO=` line, which are the invocation seams every script and skill
pastes rather than sources.

**The scripts are phase 1 only.** They carry the glue as it stood, byte-for-byte; turning it into
tested `pipeline-cli` verbs is phase 2 (#1929), and ADR
[0228](https://github.com/kamp-us/phoenix/blob/main/.decisions/0228-scripts-relay-never-derive.md) is the
boundary — a script may **relay** a verb's answer, never **derive** the decision itself.

---

## CLI. Invoking `pipeline-cli` — one canonical resolution, one exit-code taxonomy (#3314)

`pipeline-cli` is **not on PATH** where pipeline agents spawn, and nothing will put it there:
ADR [0207](https://github.com/kamp-us/phoenix/blob/main/.decisions/0207-gh-path-shim-retired.md)
retired PATH-shadowing after grounding that Claude Code applies `settings.json` `env` values
verbatim, so a `${CLAUDE_PROJECT_DIR}` PATH prepend never expands. Every invocation therefore
goes through the shim **by a resolvable path**: `claude-plugins/kampus-pipeline/bin/pipeline-cli`,
whose own three-tier ladder (in-repo dev source → SessionStart-installed data-dir bin → the pinned
`pnpm dlx`) is the single home for *which* build runs.

**Never write a bare `pipeline-cli <verb>` in a runnable command.** A bare name resolves against
PATH, is not there, and dies `command not found` — at a gate step, inside a fail-closed wrapper
that converts the miss into a *wrong verdict* rather than a clean error.

**Never write `node …/pipeline-cli/src/bin.ts <verb>` either.** Running the entrypoint through
`node` at a cwd-relative path resolves only from the repo root and only in this repo, so from a
nested app dir — the dir sessions launch in — it dies `Cannot find module` with **exit 1 and
empty stdout**. That is the more dangerous of the two failures, because it is *byte-identical to
a clean verdict* at several live call sites: `guard-content-probe classify` signals
not-guard-touching with exit 1, and `intake-dedup check` / `split-guard check` signal
nothing-found with empty stdout. A resolution failure therefore reads as a permissive answer and
the gate silently never fires (#4236). Use `"$PCLI"`.

### The canonical preamble — paste it once per bash block that invokes the CLI

```bash
# §CLI — resolve the shim. `$CLAUDE_PLUGIN_ROOT` covers a foreign consumer install; the
# git-toplevel fallback covers this repo from ANY cwd, in the primary checkout AND in an
# agent worktree (both trees carry the shim, and a worktree's toplevel is its own root).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
```

Then call it as `"$PCLI" <verb> …`. That is the **one** documented form; do not re-derive a
second. `$PCLI` is a shell variable, so — like `$BRANCH` and `$WT` — it does **not** survive
between an agent's separate Bash calls: re-run the preamble in each block, never cache the path
to a file (§SP).

### The exit-code taxonomy — "could not run" is never a verdict

The whole reason bare invocation is banned is that its failure is **indistinguishable from a
verb result** at the call site. Read the two apart this way, and never collapse them:

| Signal | Meaning | How a caller must resolve it |
|---|---|---|
| `"$PCLI" …` exits **127**, or the message names a *path* that does not exist | The CLI **never ran** — resolution failure | **UNKNOWN.** Never clean, never a negative verdict. Re-resolve or route the blocker up. |
| Exit **1** with `Cannot find module` / `MODULE_NOT_FOUND` naming a `…/pipeline-cli/src/bin.ts` path, and **empty stdout** | The CLI **never ran** — a cwd-relative `node …/src/bin.ts` invocation from a dir that is not the repo root | **UNKNOWN**, exactly as for 127 — even though the exit code collides with several verbs' ordinary "negative" result. This is the collision the ban above exists to remove; if you see it, the call site is non-canonical, not the answer negative (#4236). |
| Any other non-zero exit | The verb **ran** and returned its own documented contract (e.g. `2` findings / `3` zero scope) | Read it as that verb's result. |
| Exit 0 | The verb ran and passed | Read it as that verb's result. |

**A 127 is a PATH/resolution gap. It is NOT worktree teardown.** Teardown is progressive and has
its own two signatures, in sequence: **exit 1 with `ENOENT` on a file that provably exists on
`main`** (the earliest signal), then **exit 126 `Volta error: Could not determine current
directory`**. Treating 127 as "my tree was torn down" is a live misdiagnosis that has already
cost real time — three agents reported 127 with fully intact worktrees. Invoking by path is what
makes the distinction legible without prior knowledge: the shell's own error names the missing
**path**, not a bare command name.

For a **gate-critical** call — one whose surrounding wrapper turns any non-zero into a block or a
classification — make the refusal explicit, so an unresolved CLI can never be laundered into a
verdict:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cli-require.sh"   # §SHARED: refuses (127) unless $PCLI resolved — UNKNOWN, never a verdict
```

This section owns the **call-site resolution** half only. Two adjacent seams own the rest and
must not be re-derived here: **#4178** owns legibility when the shim's *own tree* vanishes
mid-run, and **#4185** owns legibility when the shim resolved but the CLI's module-load self-heal
failed. Both reserve the same "could not run ⇒ UNKNOWN" contract this taxonomy states, so a fix
there extends this table rather than forking it.

`pipeline-cli cli-invocation-guard check` enforces both bans mechanically over the plugin corpus
(`claude-plugins/**/*.md`) — it reds on a bare `pipeline-cli` invocation *and* on a
`node …/pipeline-cli/src/bin.ts` one inside a runnable `bash`/`sh` fence, and fails closed on zero
scope (§ZS / ADR 0092). Its corpus is markdown under `claude-plugins/` only, so `.github/workflows/`
— which legitimately runs the entrypoint through `node`, having no shim-resolution context — is out
of scope and needs no carve-out. Should the corpus ever widen past `claude-plugins/**/*.md`, the
carve-out mechanism for such a context gets documented **here**, in this section.

---

## SP. The per-run scratchpad namespace — one canonical definition (#3718)

The pipeline runs several agents concurrently by design (the WIP cap is the whole point), and
they share one `/tmp`. So an intermediate file written under a **fixed or work-item-keyed**
name is a shared mutable surface: a second run clobbers it mid-flight and the first run reads
back **the other run's content with no error**. In the live 2026-07-20 incident the file was
`prref.txt` — one reviewer overwrote it while another was mid-run, and the victim's `git diff`
silently returned the *wrong PR's* file list. Verdicts are the pipeline's routing gate, so that
is a false PASS on unreviewed code.

The class is **silent by construction**: a clobbered file reads back *successfully*, so there
is no error to catch and no defensive "re-check after read" that reliably covers it. The only
fix is structural — remove the shared namespace. This section states the rule **once** so every
skill and agent cites *one* definition instead of re-deriving it (the §CP/§DOC/§ZS/§RO
single-sourcing discipline, applied to scratch state).

**A work-item id is not a run id.** Keying on `$PR` / `<EPIC>` / `#N` does *not* make a path
unique: a re-review, a repair round, and a re-plan are all second runs over the same number,
and the operator fans gates out in parallel over one PR routinely.

### The namespace — deterministic *and* per-run

Two requirements are both real, and a namespace that satisfies only one is broken:

- **Per-run uniqueness** — concurrent runs must not be able to name each other's files.
- **Deterministic re-derivability across Bash calls** — an agent's shell state does **not**
  survive between Bash calls (`$$` differs call to call; every variable is gone), so a later
  call must be able to recompute the same path *from scratch*. A namespace allocated by a bare
  `mktemp -d` gives uniqueness and destroys this: re-running `mktemp -d` in a later call yields
  a **new empty directory** and recovers nothing.

`$CLAUDE_CODE_SESSION_ID` delivers both. It is the per-agent-run UUID the environment already
exports — the same token ADR 0115's claim protocol stamps — and it is **stable across Bash
calls** while **distinct per agent run** (sibling subagents of one pane each get their own).
So it is a run identity any later call can recompute without carrying anything.

**The harness-provided "scratchpad directory" is NOT this namespace.** A session-scoped
scratchpad handed to an agent by the runtime is **shared across the concurrent runs of that
session**, and generic leaf names under it (`verdict-doc.md`, `files-*.txt`) collide — which is
exactly how, on 2026-07-24, one reviewer's `review-doc` verdict body was written over another
reviewer's at the same path and only the ADR-0058 head-binding check (#3801) turned the
cross-PR verdict swap into a refusal instead of a merge-gate lie. Run state that must survive a
Bash call goes in the namespace below, never in that directory.

`<slug>` names the caller: the skill, plus the work item when one skill runs over several
(`plan-epic-<EPIC>`, `write-code-<N>`, `review-skill-$PR`).

### `pipeline-cli scratchpad` — the allocator, not a naming convention

Allocation is owned by one tested verb, so a caller **cites it instead of hand-rolling a path**
(#3718). It prints the absolute directory on stdout and nothing else:

```bash
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# OPEN — the run's first write of scratch state. Claims the namespace exclusively and stamps it
# as ours, clearing whatever an unclaimed earlier occupant left behind.
RUN_SCRATCH="$("$PCLI" scratchpad open --slug review-doc-$PR)" || exit 1

# RE-DERIVE — every LATER Bash call, where shell state is already gone. Asserts the namespace
# exists AND is still ours; it never creates one, because answering "you never opened it" with a
# fresh empty directory is how a read of your own state silently becomes a read of nothing.
RUN_SCRATCH="$("$PCLI" scratchpad path --slug review-doc-$PR)" || exit 1
VERDICT="$("$PCLI" scratchpad file --slug review-doc-$PR --name verdict.md)" || exit 1
```

Every failure is a **refusal with its own exit code** — `2` no session id, `3` a slug/leaf name
that isn't a single path segment, `4` the namespace belongs to another run, `5` this run never
opened it, `6` the filesystem refused — so a caller branches on status, not prose. There is **no
fallback to a shared or default location**: a fallback is precisely what reintroduces the silent
clobber (ADR 0092, fail closed).

The **owner stamp** is what makes the last case structural rather than polite — and it is a
**claim, not a check**. `open` creates the stamp with an exclusive create (`O_CREAT | O_EXCL`),
so when two runs that share a session id *and* a slug open at the same instant, the kernel picks
one winner and the loser's "already exists" **is** the refusal: exit `4`, nothing overwritten.
The winner's `path` likewise refuses to hand back a namespace another run has taken over. Note
what this is *not*: a stamp that is read, classified, and only then acted on leaves a real window
between the check and the act — it was one, and eight concurrent opens on a single session and
slug each concluded they owned it (#4028).

The stamp separates runs by identity, and there is exactly one pair it cannot: two runs whose
identity is **byte-identical** — same session id *and* same `$CLAUDE_PID`, or neither carrying
one. Nothing in the environment tells those apart, so the loser **re-enters** the namespace
instead of being refused. That re-entry is never destructive (`open` returns a namespace it
re-enters exactly as it stands), so the worst case degrades to two writers who are, by every
signal available, the same run — never one run silently reading another's state.

The verb ships with `pipeline-cli`. Where it isn't installed (a foreign install, ADR 0062), the
equivalent one-liner below is the fallback — deliberately inlined at each site rather than made a
shell helper, since a helper is itself shell state that doesn't survive between Bash calls.

**Open the run once, re-derive freely afterwards.** The distinction is load-bearing — getting
it backwards re-creates the empty-directory bug it exists to prevent:

```bash
# OPEN — the skill's first step that writes state. Fail closed on a missing session id: never
# fall back to a shared path, since a fallback resurrects the exact clobber (ADR 0092). The
# `rm -rf` clears leftovers from an EARLIER run of this same slug in this same session, so a
# re-run never reads its predecessor's files.
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || {
  echo "§SP: CLAUDE_CODE_SESSION_ID unset — refusing to write run state to a shared scratch path (#3718)." >&2; exit 1; }
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/<slug>"
rm -rf "$RUN_SCRATCH" && mkdir -p "$RUN_SCRATCH" || {
  echo "§SP: could not create the per-run scratch dir $RUN_SCRATCH." >&2; exit 1; }

# RE-DERIVE — every LATER Bash call. Same recipe ⇒ same directory ⇒ the files are still there.
# NO `rm -rf` here: that is the open step's job, and repeating it would delete the very state
# this call came to read. Assert what you expect to find, rather than reading a silent absence.
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/<slug>"
[ -s "$RUN_SCRATCH/<file>" ] || { echo "§SP: $RUN_SCRATCH/<file> did not survive — re-run the opening step in THIS session." >&2; exit 1; }
```

**Assert presence, never let a test decide on an absent file.** A missing scratch file is not
a neutral input: `[ existing -nt missing ]` is **true** in bash, so a freshness/staleness guard
written as `if ! [ "$a" -nt "$b" ]` **passes silently** when `$b` is gone — the guard reads
green precisely when its precondition is most broken. Check `-s` first (`plan-epic`'s Step-5
splice guard is the live instance), so absence fails loud instead of waving work through.

### The rules, in preference order

1. **Prefer no file at all.** Pass the value in-process. `report` streams the issue body over
   stdin rather than round-tripping a temp path (#2002), and `write-code` re-derives the branch
   live from the worktree instead of caching it (#2038) — both satisfy §SP outright, with no
   path to collide on and nothing to leak.
2. **When a file is genuinely needed, derive its path from `$RUN_SCRATCH`.** Allocate it
   through `pipeline-cli scratchpad open` (or, with no CLI, the fallback one-liner) — never a
   bare `/tmp/<name>`, never the harness scratchpad, and never a path keyed only
   on a work-item id. Leaf names then stay plain and readable (`deps.md`, not
   `deps-$PR-$RANDOM.md`) because uniqueness lives in the **directory**, so a scratch write
   added later *inherits* the guarantee instead of reintroducing the bug.
3. **Never park a `$RUN_SCRATCH` path in another file to carry it across Bash calls** — that
   just relocates the collision onto *that* file. You don't need to: **recompute it** from the
   same `run_scratch` recipe, which is deterministic precisely so this rule costs nothing.
4. **Carve-out — a raw `$(mktemp "${TMPDIR:-/tmp}/<name>.XXXXXX")` (or a throwaway
   `$(mktemp -d)`) is §SP-compliant when it is allocated *and* consumed inside one Bash
   call.** The kernel supplies the uniqueness, so there is no shared name to clobber, and a
   path that never crosses a call needs no deterministic recipe. This is the right shape for a
   verdict file written and immediately `cat`-ed into a `gh api` post (`review-code` /
   `review-doc` / `review-skill` `VERDICT_FILE`, `ship-it`'s flag-const list), and for §RO's
   throwaway head worktree (`git worktree add "$(mktemp -d)/…"`). It is a **deliberate second
   form, not a tolerated exception** — stated here so it isn't re-bred as a competing
   convention, and so a reader who meets both forms knows which one they are looking at.

   The line between rule 4 and rules 2+3 is **lifetime, not file count**: the moment a path
   has to survive into a *later* Bash call, the carve-out no longer applies and it belongs
   under a session-derived `$RUN_SCRATCH`. Give a rule-4 temp a name that says what it holds
   (`review-code-verdict.XXXXXX`), never the `kampus-run` prefix the rule-2 namespace uses —
   the two forms should stay tellable apart at a glance.

### Corollary — a scratch path is a local absolute path, so it never lands in a public artifact

`$RUN_SCRATCH` expands to a machine-local absolute path. Quoting one into an issue body, PR
body, comment, or commit message leaks the operator's filesystem layout — the leak `leak-guard`
enforces against (#2683), and the reason a body is posted **by value** (`-f body="$(cat …)"`)
rather than by `gh api -f body=@<path>` (#2002 / #754). Compose *through* the scratch file;
never mention it in what you post.

---

## WL. A loop exit is not evidence, and `grep -qv` is not a condition (#4155)

Two shell-level rules the pipeline's agent-executed steps share. Both fail in the **same
direction** — a condition meaning *not yet* / *not allowed* reads as *done* / *allowed*, and
control flow proceeds — which is the silent direction: a loop that hangs is visible, a loop that
exits early on a false condition is not. They are stated here once so every skill cites one
definition.

**1. A wait-loop's exit is never evidence of the awaited condition.** A loop controls *when* you
re-read; it never substitutes for the read. On exit — whether the loop broke, timed out, or
tripped a malformed condition — **re-assert the terminal state from ground truth** before
reporting it. The live instance: a shipper improvised a `grep -qv null` poll while waiting on a
merge queue; the condition succeeded on poll 1 and the loop exited on a state that meant "not
merged yet" (#4155, on PR #4076). Nothing was misreported only because that shipper concluded
from a direct `merged_at` + timeline read instead of from the loop — discipline, not a control.

**2. Never use `grep -qv` / `grep -vq` as a loop or branch condition.** Two independent
mechanisms break it, and both land on a false-true:

- **Semantics.** `grep -v <pat>` succeeds when *any* line lacks the pattern, so over a
  multi-line/multi-field read a `grep -qv` test is true almost unconditionally — it does **not**
  mean "no line matches".
- **Portability.** The `-q` + `-v` combination misbehaves under some grep variants (ugrep returns
  non-zero even when non-matching lines exist), so `! grep -qv …` — the "every line matches the
  allowed prefix" idiom — can read true for a set that contains disallowed entries.

**The remedy — capture the inverted match and test emptiness, never the exit status.** This is the
form [`lefthook.yml`](https://github.com/kamp-us/phoenix/blob/main/lefthook.yml)'s pre-push
`typecheck` leg already uses and documents (#3130 → #3403); that comment is the anchor, and this
section is its pipeline-side statement — don't restate the rationale at each call site, point here:

```sh
# "every changed path is under skills/ or agents/" — the empty-output form
OFFCLASS=$(grep -vE '^claude-plugins/kampus-pipeline/(skills|agents)/' <<<"$FILES")
if [ -n "$FILES" ] && [ -z "$OFFCLASS" ]; then …
```

---

## HEAD. Review the PR head, never the launched checkout's working copy (#793)

A review gate is frequently spawned with `isolation:worktree`, which lands it in a **fresh
worktree on a branch cut from `origin/main` (the base)** — *not* the PR branch. So the gate's
**current working directory is the BASE version of every file.** A plain full-file `Read` (or
`cat`, `grep` in CWD) then resolves against the **pre-PR base**, and the reviewer reviews the
wrong code while binding its verdict to the correct head SHA — the silent gate-integrity bug
this section closes (issue [#793](https://github.com/kamp-us/phoenix/issues/793)). The
dangerous case is the **false PASS**: a worktree reviewer reading base code green-lights a PR
whose actual changes are broken, and `ship-it` merges on that PASS — a review that reads the
wrong file version is a gate that doesn't gate. This is orthogonal to §RO (which keeps the
gate's *writes* off the owner's tree) and to the 0052/0067 split (which keeps the head's
*instructions* out of the reviewer's path): §HEAD is about **which version the reviewer
*reads***. This section states the rule **once** so every review gate cites *one* definition
rather than each re-deriving the per-invocation head-checkout that prompts have been bolting on
ad hoc.

**The invariant — a review gate MUST source ALL code/prose under review from the PR head, and
assert it did:**

1. **Resolve + materialize the head via the shared `pipeline-cli review-head` verb — never
   re-derive it inline** (#3690 / #793 / #1807; `packages/pipeline-cli/src/tools/review-head/`).
   The verb owns the deterministic mechanism this section used to spell out inline: it resolves the
   live head SHA up front via REST (never GraphQL — the SHA the verdict binds to, §5/ADR 0058),
   fetches the head into a per-run ref (never the launched checkout — the §RO read-only path), and
   **asserts the fetched ref resolves to exactly that SHA before you review** — aborting on a moved
   head rather than binding a stale verdict. Two modes, same core:
   ```bash
   # §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
   PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
   # ref-only (review-doc reads via `git show "$PR_REF:<path>"`):
   eval "$("$PCLI" review-head materialize --pr "$PR" | jq -r '"PR_REF=\(.prRef); HEAD_SHA=\(.headSha)"')"
   # full detached head worktree (review-code / review-skill), emitted as `.worktreeDir`:
   "$PCLI" review-head materialize --pr "$PR" --worktree | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$WT_FILE"
   ```
   `pull/<pr>/head` resolves same-repo AND cross-fork, and the checkout is always DETACHED onto the
   per-run ref — never `gh pr checkout` / `git checkout` / `git switch`, which would land the head in
   the shared PRIMARY the harness resets a subagent's cwd to and detach the human's `main`
   (#2270/#1103; the verb refuses this outright). Run `iso_preflight` (§RO-iso) BEFORE the verb.
2. **(owned by the verb, step 1)** — the per-run-ref fetch + the fetched-ref-IS-the-head assertion
   are the verb's, not a step each gate re-derives; `review-design` reviews a preview URL rather than
   a tree, so it uses the lighter `pipeline-cli review-head resolve --pr "$PR"` (the head SHA only).
3. **Read every file under review FROM THE HEAD, never from CWD.** Route full-file reads
   through `git show "$PR_REF:<path>"` (or read from the throwaway head worktree the gate
   already materializes — `git worktree add "$(mktemp -d)/…" "$PR_REF"`, `$REVIEW_WT`), and
   search the head with `git grep <pattern> "$PR_REF"`. **Do NOT `Read`/`cat`/`grep` a
   working-copy path for product/prose under review** — under `isolation:worktree` that path is
   the base. The diff itself (`gh pr diff $PR`) is already head-vs-base and is fine; the trap is
   the *full-file* read for surrounding context.
4. **Re-check the live head before posting; abort a stale-bound verdict.** If the head moved
   while you reviewed (re-resolve `headRefOid` and compare to `$HEAD_SHA`) or the head can't be
   reached, do **not** post a verdict bound to a SHA you no longer reviewed — re-resolve and
   re-review the new head, or abort. A verdict's `@ <HEAD_SHA>` marker (§5) must name the SHA
   whose *files you actually read*, and the verdict body must **assert it read the PR head (not
   the launched CWD)**, so a base-code review is self-evidently invalid to a human adjudicator.

Gates that materialize a full head worktree for behavior verification (`review-code`,
`review-skill`) satisfy #3 by reading from `$REVIEW_WT` (head) and running commands via
`pnpm -C "$REVIEW_WT"`; the diff-only gate (`review-doc`) satisfies it via
`git show "$PR_REF:<path>"`. Either way, the launched checkout's working copy is never the
source of code under review.

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

`review-code` writes **exactly one** marker comment per PR in its namespace. That upsert is
**`pipeline-cli verdict post`'s own behavior, not something a reviewer hand-rolls**: the verb
scans the PR for **its own** prior `review-code:` marker keyed on `(namespace, head, runId)`
and, if one exists, replaces that comment in place with the fresh verdict + fresh `@ <sha>`
instead of appending a new one. A re-review at a **new** head appends a fresh record and leaves
the prior head's verdict standing (that is what the `head` dimension of the key buys — #4007,
ADR 0213); a re-post at the **same** head upserts, so no head's slot ever accumulates a stale
verdict stream a millisecond decides. See ADR 0058 rule 2.

**Do not translate this into a raw `gh api` comment `PATCH`.** A hand-rolled patch of a verdict
body is a marker hand-post — it skips `emissionDefect` and the post-write `verifyLanded` re-scan,
which is exactly the emit-side bypass [The guarded emit path is
MANDATORY](#the-guarded-emit-path-is-mandatory--never-hand-post-a-verdict-marker-off-the-guard)
forbids (#2789 / #2816 / #2818). If a raw post is genuinely unavoidable, take that section's one
escape hatch — `pipeline-cli leak-guard scan-comment` on the body **first**.

### The matcher contract: emphasis-tolerant + SHA-capturing (canonical shape)

The marker line may carry **leading Markdown emphasis** — `review-code` historically emits
it bolded (`**review-code: PASS @ <sha> — merge-ready**`), `review-doc` emits it bare. To stop
the emitter and the matcher from drifting apart (the bolded marker once read as "no verdict"
and stalled every code-lane merge — #219), this contract pins **one** rule both sides cite:

- **Canonical emit shape** (what an emitter SHOULD write): the bare, unbolded first line —
  `review-code: PASS @ <sha> — merge-ready`. New/converging emitters write this.
- **Token order is fixed** (the single source every emitter cites): the `@ <sha>` comes
  **immediately after** the `PASS`/`FAIL` polarity and **before** the `— merge-ready` /
  `— not merge-ready` tail — `review-code: PASS @ <sha> — merge-ready`, never
  `review-code: PASS — merge-ready @ <sha>`. The matcher below is **anchored to this order**:
  it captures the SHA only when `@ <sha>` directly follows the polarity, so a marker that
  pushes `@ <sha>` *past* `merge-ready` captures `sha=null` → the consumer resolves it
  `unverified` and refuses a correct, current-head PASS (the token-order drift that silently
  stalled #623's merge — #625). The fix is to **emit the canonical order**, not to loosen the
  matcher to chase a trailing SHA (ADR 0058 forbids weakening the SHA-binding). §6/§6.5 inherit
  this order for `review-doc` / `review-skill` via the same matcher contract.
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
- **Forbidden emit forms** (what an emitter MUST NOT write): the matcher above is anchored, so
  an emitter that freelances any of the shapes below produces a verdict **no consumer can read**
  — `ship-it` resolves the PR to `unverified` and silently refuses to merge a genuine,
  current-head PASS (the #1095 stall: a real PASS posted as `<!-- review-code: PASS sha:… -->`
  sat unmerged). The emit contract is the mirror of the matcher — emit the canonical first line
  and **none** of these:
  - **HTML-comment-wrapped** — `<!-- review-code: PASS @ <sha> — merge-ready -->`. The `<!--`
    is non-whitespace ahead of the namespace token, so it fails the `^\s*\**\s*` anchor (the
    `\**` absorbs only Markdown emphasis, never `<!--`). The marker must be **live body text**,
    not an HTML comment — the verdict-marker contract has no HTML-comment form (the only
    sanctioned HTML comment in these formats is the unrelated AC-append provenance tag of §2).
  - **`sha:` (or any non-`@`) SHA delimiter** — `review-code: PASS sha:<sha>`. The matcher
    captures the bound SHA only from the literal `@ <sha>` tail; `sha:<sha>` matches only the
    looser SHA-less prefix → `unverified`. The delimiter is `@`, never `sha:`/`SHA=`/`commit:`.
  - **Heading-only / prose-only verdict** — `## review-code verdict: PASS` with no marker line.
    A heading is not the contract: it carries no `@ <sha>` and isn't anchored at the namespace
    token. The recognizable first line is required *in addition to* any human-facing heading.
  - **Marker not on the literal first line** — the `^` anchor pins the marker to the **start of
    the comment body**; a marker buried after a preamble paragraph never matches. It leads the
    body.
  - **Two namespace markers stacked in one comment (the multi-namespace fan)** — on a
    mixed-class diff the reviewer fans several verdict namespaces (e.g. `review-code` +
    `review-skill` for a skill+code PR, `review-design` for a UI PR). Each namespace's `^`
    anchor pins its marker to the first line of **its own comment**, so stacking a second
    namespace's marker on line 2 of the first's comment leaves that second marker un-anchored:
    it never matches, its namespace resolves **empty**, and `ship-it` fail-closes a
    substantively-PASS PR (the live PR #2456 stall — both reviews PASSed, but the stacked
    `review-skill` marker was unmatchable and recovery needed a manual re-emit). **Emit each
    fanned namespace's verdict as its OWN separate PR comment, its `<namespace>: PASS|FAIL @
    <sha>` marker on that comment's literal first line — one comment per namespace, never two
    markers stacked.** The upsert is still one-comment-per-`(PR, namespace)`; the fan writes
    N such comments (one each), not one comment carrying N markers.
  These are emitter bugs, not matcher gaps — the fix is always to **emit the canonical shape**,
  never to loosen the anchored matcher to chase a malformed marker (ADR 0058 forbids weakening
  the SHA-binding). §6/§6.5/§6.7 inherit this forbidden-forms list for `review-doc` /
  `review-skill` / `review-design` via the same matcher contract.

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
(the **§DOC doc class**: `.decisions/**`, `.patterns/**`, `docs/**`, or a root/top-level
prose `*.md` — explicitly **not** a code-root `*.md` under `apps/**`/`packages/**`, which
rides `review-code`) against its
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
PR (§CP — approval-gated)`) so its verdict stays *out* of `ship-it`'s PASS namespace — a §CP PR
merges only once a `@kamp-us/control-plane` member approves at head and `ship-it` enqueues it
(ADR [0135](https://github.com/kamp-us/phoenix/blob/main/.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
amending [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md);
`ship-it` is the single merge actor, ADR
[0048](https://github.com/kamp-us/phoenix/blob/main/.decisions/0048-ship-it-merge-actor.md)). The advisory line
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

`review-doc` writes **exactly one** `review-doc:` marker comment per PR. As in §5 this is
`pipeline-cli verdict post`'s own behavior — the verb finds **its own** prior `review-doc:`
marker and replaces it in place with the fresh verdict + fresh `@ <sha>` rather than appending
(ADR 0058 rule 2; same mechanism as §5, including §5's "never hand-roll this as a raw
`gh api` `PATCH`").

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
  (§6.6), not a PASS marker — `review-doc`'s verdict does not authorize that merge; a
  `@kamp-us/control-plane` approval at head does, and `ship-it` enqueues on it (ADR 0135
  amending 0053). This keeps the control-plane approval gate intact.
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
review-skill: advisory — blocking-set PR (§CP — approval-gated)
```

so its verdict stays *out* of `ship-it`'s PASS namespace — a §CP PR merges only once a
`@kamp-us/control-plane` member approves at head and `ship-it` enqueues it (ADR 0135 amending
0053; `ship-it` is the single merge actor, ADR 0048).
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

`review-skill` writes **exactly one** `review-skill:` marker comment per PR. As in §5 this is
`pipeline-cli verdict post`'s own behavior — the verb finds **its own** prior `review-skill:`
marker and replaces it in place with the fresh verdict + fresh `@ <sha>` rather than appending
(ADR 0058 rule 2; same mechanism as §5/§6, including §5's "never hand-roll this as a raw
`gh api` `PATCH`").

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
  authorize that merge; a `@kamp-us/control-plane` approval at head does, and `ship-it` enqueues
  on it (ADR 0135 amending 0053/0065). This keeps the control-plane approval gate intact, and is
  exactly the common case for a skill PR (every gate skill is gate-critical).
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on;
  `review-skill` writing it does **not** merge (see review-skill/SKILL.md §"Authority limit").

---

## 6.6. The canonical advisory line — one form for all four gates

The gates once expressed "advisory" two ways: `review-code` emitted a binding
`PASS @ <sha> — merge-ready` line *plus* a control-plane caveat, while `review-doc`
suppressed the binding PASS and led with a **no-`@ <sha>`** advisory line. ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §5 picks
`review-doc`'s form as the **single canonical advisory shape** and converges all the gates on
it; the later `review-design` gate (§6.7, ADR 0165) adopts the same form from birth.

For a PR in the **control-plane / blocking set** (§CP), the gate emits a comment whose first
line is the **no-`@ <sha>`** advisory marker in its own namespace:

```markdown
review-code:   advisory — blocking-set PR (§CP — approval-gated)
review-doc:    advisory — blocking-set PR (§CP — approval-gated)
review-skill:  advisory — blocking-set PR (§CP — approval-gated)
review-design: advisory — blocking-set PR (§CP — approval-gated)
```

The rest of the body carries the same per-check evidence table the PASS/FAIL paths carry —
the verdict is *recorded* (for the human or delegated merge actor to read), it just **authorizes
nothing on its first line**. The advisory **first line** **carries no `@ <sha>`** on purpose: it
does not enter any `ship-it` `PASS @ <sha> — merge-ready` namespace, so a §CP PR is never
auto-mergeable off it (ADR 0053). Under ADR 0135's approve-then-enqueue, `ship-it` enqueues it once a
`@kamp-us/control-plane` approval is present at head (ADR 0053/0065/0135) — that approval, not a gate
verdict, is what authorizes the merge.

**The advisory body MUST carry the canonical `Reviewed-head` line (ADR 0151).** Immediately after
the advisory's first-line marker + framing prose, the body carries **exactly one** line recording
the reviewed head SHA in a fixed, machine-parseable form:

```markdown
Reviewed-head: @ <HEAD_SHA>
```

This is the single canonical binding for a §CP advisory — it replaces the free-prose "reviewed head"
phrasings (which spelled the SHA half a dozen incompatible ways and made the §CP enqueue
nondeterministic; #1932/#2022). It is a **body** line with a **distinct `Reviewed-head:` token**, so
it is never matched by the first-line `review-(code|doc|skill): PASS @ <sha>` PASS-namespace matcher —
the advisory stays out of `ship-it`'s auto-merge namespace exactly as ADR 0111 requires. Both a human
delegated merge actor and `ship-it`'s ADR-0135 approval-aware §CP enqueue read the reviewed head from
**this** line, via the anchored matcher (case-insensitive, optional `@`, 7–40 hex, ADR 0058
prefix-match either side):

```
^\s*Reviewed-head:\s*@?\s*([0-9a-f]{7,40})\b
```

`ship-it` treats the §CP advisory namespace as an enqueue-eligible current-head PASS-equivalent iff
(a) this `Reviewed-head` SHA prefix-matches the PR's current head, (b) every body checkbox is
`[PASS]`, and (c) Step 0's control-plane approval is present at head — else it refuses
deterministically (ship-it Step 2.§CP, ADR 0151). The reviewer is **never** asked to emit a bindable
first-line PASS on a §CP PR to unblock enqueue (ADR 0111's advisory-is-SHA-less-in-first-line
invariant is preserved; the reviewer marker contract is not widened).

This is why the advisory form is namespace-uniform but binding-free: it keeps each gate's
verdict **out** of `ship-it`'s merge path for the control plane while still leaving a
visible, evidence-bearing verdict on the PR. (`review-code`'s historical binding-PASS +
caveat shape was retired in favor of this; the reconciliation landed with #424.)

**The first-line `@ <sha>` is omitted by design — the SHA is bound in the body's canonical
`Reviewed-head` line, and both a delegated merge actor AND `ship-it`'s §CP enqueue confirm from
that body line, not the first-line marker (ADR 0111/0151).** The advisory line deliberately
withholds the first-line `@ <sha>` so it never enters `ship-it`'s `PASS @ <sha> — merge-ready`
namespace — that withholding is exactly what makes `ship-it` refuse to *auto-merge* the §CP PR off a
first-line PASS (ADR 0053). It is **not** a missing binding: the head SHA the reviewer inspected is
recorded in the verdict **body** on the canonical `Reviewed-head: @ <sha>` line + the per-AC PASS
table, per ADR 0058. So a **delegated** control-plane merge actor — an operator hand-merging a banked
§CP PR, or `ship-it`'s ADR-0135 approval-aware enqueue acting on the maintainer's current-head
APPROVE — must **not** try to bind the first-line marker (it will read as `unverified`, the
SHA-less-by-design form #977 hit). It confirms the verdict by **reading the body**: the
`Reviewed-head` `@ <sha>` against the PR's current head + every AC marked PASS, then applies
`ship-it`'s just-in-time guards (head freshness, mergeable, no failing required check) and
merges/enqueues. A namespace-isolated bindable *first-line* SHA was rejected (it would invite
automated §CP auto-merge and erode ADR 0053) — ADR 0151 instead makes the *body*'s binding canonical
and machine-read, keeping ADR 0111 intact. See
[ADR 0111](https://github.com/kamp-us/phoenix/blob/main/.decisions/0111-blocking-set-verdicts-sha-less-by-design.md)
and [ADR 0151](https://github.com/kamp-us/phoenix/blob/main/.decisions/0151-cp-advisory-body-sha-resolves-approval-aware-enqueue.md).

---

## 6.7. review-design verdict marker

`review-design` is the **design-class gate** — the fourth reviewer skill alongside
`review-code` (§5), `review-doc` (§6), and `review-skill` (§6.5). It gates a **UI-affecting
PR** by driving Playwright over the PR's preview deploy, capturing the changed UI surfaces,
and judging the rendered screenshots multimodally against the **four-pillars design law**
(ADR [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md);
the gate itself is ADR [0165](https://github.com/kamp-us/phoenix/blob/main/.decisions/0165-review-design-gate.md),
skill landed via #2246). It hard-FAILs **only** on the six enumerable, objective ADR-0162
prohibitions; all holistic/taste judgment rides as advisory (non-blocking) notes in the same
verdict comment. It lands its verdict as a **comment whose first line is a recognizable,
SHA-bound marker** — and **only** that comment, never a native review (like `review-doc` /
`review-skill`, ADR 0058 rule 4). The marker lives in its **own namespace**, distinct from
§5's `review-code`, §6's `review-doc`, and §6.5's `review-skill`.

### Shape — SHA-bound (ADR 0058)

The recognizable **first line** of the PR comment carries the head SHA the reviewer
inspected (`@ <sha>`, from `gh api repos/$REPO/pulls/$PR --jq .head.sha`):

```markdown
review-design: PASS @ <sha> — merge-ready
```

```markdown
review-design: FAIL @ <sha> — changes-requested
```

For a PR in the **control-plane / blocking set** (§CP), `review-design` is **advisory only**
and instead leads with the **canonical advisory line** (§6.6):

```markdown
review-design: advisory — blocking-set PR (§CP — approval-gated)
```

so its verdict stays *out* of `ship-it`'s PASS namespace — a §CP PR merges only once a
`@kamp-us/control-plane` member approves at head and `ship-it` enqueues it (ADR 0135 amending
0053; `ship-it` is the single merge actor, ADR 0048).
The advisory line carries **no `@ <sha>`** by design: it authorizes nothing, so there is
nothing to bind.

The rest of the body carries the per-prohibition table (the six hard-FAIL checks, passing
rows too), an **Advisory (non-blocking)** section, and an **Evidence** section embedding the
GitHub-hosted screenshot URLs so a human can see what was judged. What's load-bearing for the
scanner is the namespace, the polarity, **and the `@ <sha>`** — the same staleness contract as
§5/§6/§6.5: `ship-it`/`write-code`-repair refuse a `review-design` verdict whose `@ <sha>` is
not the PR's current head, and refuse a SHA-less one (ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), issue #258).

### Comment-only (ADR 0058)

`review-design` emits its verdict **only** as the SHA-bound `review-design:` comment,
**never** a native `APPROVE`/`REQUEST_CHANGES` review — for the same reason `review-doc` /
`review-skill` are comment-only (§6/§6.5): a native review cannot carry the `@ <sha>` in the
shape this contract controls, so one comparable record type per lane keeps the lane
resolvable.

### Upsert, not append (ADR 0058)

`review-design` writes **exactly one** `review-design:` marker comment per PR. As in §5 this is
`pipeline-cli verdict post`'s own behavior — the verb finds **its own** prior `review-design:`
marker and replaces it in place with the fresh verdict + fresh `@ <sha>` rather than appending
(ADR 0058 rule 2; same mechanism as §5/§6/§6.5, including §5's "never hand-roll this as a raw
`gh api` `PATCH`").

### The matcher contract — anchored, never cross-matching (canonical shape)

`review-design` adds a **fourth** namespace to the §5 matcher family, on the same
emphasis-tolerant + SHA-capturing rule. The four matchers are mutually exclusive by
construction — anchored at `^\s*` so a mid-body quote never matches, and each names its own
token so a scan in one namespace can **never** cross-match another:

- code:   `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- doc:    `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- skill:  `^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- design: `^\s*\**\s*review-design:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`

The tokens are distinct literals, and because each ends in a different word (`code:` /
`doc:` / `skill:` / `design:`) no anchored literal prefix-matches another — the four are
disjoint. `review-design` also inherits §5's **token-order** rule (`@ <sha>` immediately
after the polarity, before the `— merge-ready` / `— changes-requested` tail) and its
**forbidden emit forms** (no HTML-comment wrapper, no `sha:` delimiter, no heading-only
verdict, marker on the literal first line). Every matcher site cites this one rule so they
can't diverge.

### The `Reviewed-head` body anchor (ADR 0151)

Every `review-design` verdict body carries the canonical **`Reviewed-head: @ <sha>`** line
(§6.6 / ADR 0151) — the read-back guard asserts it on every path, and a delegated §CP merge
actor (and `ship-it`'s ADR-0135 approval-aware enqueue) resolves the reviewed head from
**exactly that line** on an advisory §CP verdict, never from the first-line marker.

### Field notes

- **Separate namespace.** `ship-it` resolves each gate's verdict in its **own** namespace,
  latest-verdict-wins by timestamp, then the SHA-staleness test (§5/§6/§6.5). `review-design`
  never emits a `review-code` / `review-doc` / `review-skill` marker, and they never emit a
  `review-design` one.
- **First line, recognizable.** The marker leads the comment so a scan matches it without
  parsing the whole body. Recognize it tolerantly by shape (`review-design: PASS @ <sha>` …
  `merge-ready`) and emphasis (optional leading `**`, §5 matcher contract), not by exact
  dashes — but the `@ <sha>` is required.
- **Two markers, two consumers.** `PASS @ <sha> — merge-ready` (every applicable prohibition
  passed or N/A, bound to that head) is the go-ahead signal `ship-it` acts on to merge a
  **non-blocking** UI PR **iff `<sha>` is the current head**. `review-design`'s required-gate
  wiring **has landed** as part of the ADR-0165 rollout: `ship-it` runs the `UI_RE` probe and
  refuses a `has-ui` PR with an empty `review-design` namespace, and §CLASS's
  `pipeline-cli class-probe classify` folds the additive gate in.
  `FAIL @ <sha> — changes-requested` (≥1 objective prohibition violated) is read by
  `write-code`'s fix round-trip as "my UI PR came back failed"; `ship-it` reads it as "do not
  merge."
- **Advisory for the blocking set.** A UI PR in the §CP set gets the **canonical advisory
  line** (§6.6), not a PASS marker — its verdict does not authorize that merge; a
  `@kamp-us/control-plane` approval at head does, and `ship-it` enqueues on it (ADR 0135 amending
  0053/0065). Because a design verdict is calibrated to FAIL conservatively (a borderline call is
  downgraded to advisory), an advisory here can also mean "no objective prohibition hard-failed" —
  but on a §CP PR the first-line advisory is always the approval-gated shape.
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on;
  `review-design` writing it does **not** merge (see review-design/SKILL.md §"Authority
  limit").

---

## 7. Issue-claim semantics — a session-id-stamped claim comment (the agent-distinguishable claim marker, ADR 0115)

This section is the **single source** of the agent-distinguishable claim primitive (ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md),
#1452): the canonical claim-comment grammar, the `CLAIM_RE` matcher, and the
earliest-authorized-claim tiebreak. **Three lock surfaces adopt it verbatim and none
re-derive it** — `write-code`'s issue claim (Step 3), the orchestrator's pre-spawn claim
(`.claude/workflows/drive-issue.js`), and the `status:planning` epic-lock's planning-claim
comment (§The `status:planning` epic-lock; `plan-epic`/`review-plan`). The
mis-attribution guard (`write-code` #1456) reads this same surface to prove a target is its
own before mutating it. Every consumer cites the `CLAIM_RE` and tiebreak defined **here**.

The **resolution** side of this contract — resolve one owner by the earliest authorized
claim and decide "is it mine?", default-deny — is implemented once as the shared verb
`pipeline-cli claim is-mine --issue <N>` (#3687, reusing the epic-lock `resolveClaim` core);
a consumer runs the verb rather than hand-rolling the resolution `jq`, exactly as §5/§6 route
every marker emit through `pipeline-cli verdict post`. The bash resolution shown below is the
canonical *reference* the verb implements — read it to understand the tiebreak, run the verb
to make the decision.

### Why the bare assignee login cannot be the claim

`write-code` claims by **self-assigning** and the picker's "skip assigned issues" rule
(Step 1) reads it — but the assignee is **last-write-wins, not compare-and-swap**. GitHub's
`POST /issues/{N}/assignees` is **additive** (it co-assigns, never displaces, with no
`If-Match`), so two agents that both saw #N unassigned co-assign `[A, B]` (#260). Worse,
**every draining agent in this pipeline pushes as the single git identity `usirin`** —
`ME=$(gh api user --jq '.login')` is always `usirin` — so the previous design's
`lexicographic-min(login)` tiebreak **degenerates to a no-op**: two co-racers both compute
`min == usirin == me` and both proceed (the #1431 double-implement root cause, ADR 0115
§Context). The login is **agent-indistinguishable**; the fix is a per-agent identifier the
runtime already exposes.

### The two layers — coarse availability gate + fine agent-distinguishable claim

The claim is **two layers** (ADR 0115 §1):

- **Coarse availability gate — the assignee field (unchanged).** Self-assign stays as the
  cheap, list-visible "is this taken at all?" signal the Step-1 picker reads (`skip on any
  non-null assignee`). It is **login-blind by design** and decides nothing about *which*
  agent owns the work — it only narrows the field and tolerates a transient double-assign.
  It is also the **only** layer the picker reads, so it is what keeps a finished lane out of an
  idle picker's pool while the PR is in review — see
  [Who writes layer one](#who-writes-layer-one-the-claim-winner-on-both-paths).
- **Fine, agent-distinguishable resolution — the claim comment (the resolver).** A
  structured issue comment carrying the claiming agent's `CLAUDE_CODE_SESSION_ID` — the
  per-session UUID Claude Code exposes in every (sub)agent's environment (read today by
  `report`'s footer; ADR 0115 §Grounding). Two concurrent subagents under the same `usirin`
  login carry two distinct session UUIDs, so the comment **is** the distinguishing key the
  login is not.

### The canonical claim marker + `CLAIM_RE` — single-sourced here

The claim comment is **one line, emphasis-tolerant**, exactly as the SHA-bound verdict
markers (§5/§6) are. Its **canonical grammar**:

```
claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC>
claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC> · presence <machine-fingerprint>/<session-pid>
```

- **The optional `presence` stamp** names the claiming **session process** (the long-lived
  `claude` ancestor of whatever posted the claim) and an opaque **fingerprint of the machine** it
  runs on — a truncated hash of a *machine-scoped* id (macOS `IOPlatformUUID` / Linux
  `/etc/machine-id`), **never the hostname**: liveness only asks "is this my machine?", a hostname
  is not unique to one machine, and no machine identity belongs in a public timeline. It exists so
  a later reader can *probe* this claimant's liveness instead of guessing — see
  [Dead-claimant supersession](#dead-claimant-supersession-proven-death-only-adr-0191). It is
  **optional**: an unresolvable session — or an unresolvable machine identity — stamps nothing,
  and an unstamped marker reads as indeterminate (⇒ still a valid owner), so legacy markers keep
  their exact old meaning. Optional-per-marker is **not** optional-per-writer, though: a writer
  that never stamps makes every claim it posts permanently indeterminate, which silently switches
  supersession off for that whole lane while the mechanism looks fixed (#3987). So the stamp is
  emitted by **one producer** and every writer routes through it — the write surface below.
- **Token source:** the claiming process's `CLAUDE_CODE_SESSION_ID` environment variable
  (the orchestrator's when it claims pre-spawn; the coder's when `write-code` is invoked
  directly — see §The pre-spawn claim protocol).
- **Write surface — the shared verb, never a hand-rolled `gh api`.** Post the claim with
  `pipeline-cli tracker claim <N>` (`--session <token>` to claim under a threaded/delegated
  token). The verb owns the whole write: Rule-0 defer to a pre-existing authorized owner, the
  comment POST with the presence stamp composed by the single producer, the checkpoint-GET
  tiebreak, and retract-our-own-claim-on-loss. **Exit 0 = the claim is ours, non-zero = backed
  off, do not mutate.** Never compose a `claim:` body by hand — a hand-rolled marker skips the
  stamp (see the bullet above), and `pipeline-cli adoption-lint check` reds a corpus file that
  re-derives this write instead of citing the verb.
- **Read surface — the canonical `CLAIM_RE`.** A claim comment is matched by this **one**
  anchored, case-insensitive, emphasis-tolerant regex; every consumer cites it and **none
  re-hard-codes the grammar** (it pairs with §5/§6's marker-matcher discipline). The executable
  matcher is the `RegExp` in `tools/epic-lock/claim-resolution.ts`; the jq/PCRE rendering below is
  single-sourced in `gate-boundaries.ts` and drift-locked to both (#4401):

  ```
  CLAIM_RE='(?i)^\s*\**\s*claim:\s*[0-9a-f-]{36}\b'
  ```

  The `[0-9a-f-]{36}` body matches a `CLAUDE_CODE_SESSION_ID` UUID; the embedded session id
  is captured with the paired form `(?i)^\s*\**\s*claim:\s*(?<s>[0-9a-f-]{36})`. The
  `\**` absorbs any leading bold-marker exactly as the verdict matchers do.

### The tiebreak — earliest *authorized* claim wins, recognized by session id

The session id is the **identity** key, **not** the ordering key. The single winner is
selected by the **server-assigned ordering of the authorized claim comments**: the canonical
winner is the claim with the **minimum `(created_at, comment id)`** — the **earliest
authorized claim**, with the strictly-monotonic, server-assigned, globally-unique comment
`id` as the unique sub-key when timestamps tie. An agent recognizes ownership by comparing
that winning claim's embedded session id to its own token:

```
won  ==  earliest-authorized-claim.session  ==  $CLAUDE_CODE_SESSION_ID
```

"**Authorized**" is the ADR [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
trust root — the same write+ collaborator gate `ship-it` Step 2 and the `write-code` repair
scan apply: keep only claim markers **authored by an account holding `write+` on the repo**.
A forged claim from a non-collaborator is **ignored**; an **empty authorized set resolves no
winner — fail-closed**, never a false win. The matcher that resolution scans with is the one
machine-readable copy in this file (read tolerantly per the §Reading stance):

```bash
# The canonical CLAIM_RE stays here at column 0 for the same reason §CP's CONTROL_PLANE_RE line
# does: `validate-gate-path-drift.sh` and the live gates re-resolve it from THIS file on
# origin/main (#981, #4401), so it must remain present, byte-identical, exactly once.
CLAIM_RE='(?i)^\s*\**\s*claim:\s*[0-9a-f-]{36}\b'
```

**Do not hand-roll the resolution around it.** `pipeline-cli claim is-mine --issue <N> --session
<token>` owns the whole read — the `CLAIM_RE` scan, the ADR 0055 write+ filter, the earliest
`(created_at, comment id)` tiebreak, and the default-deny outcome — and `pipeline-cli adoption-lint
check` reds a corpus file that re-derives it instead of citing the verb.

The race-case derivation this tiebreak rests on — staggered co-racers, where the comment POST
detects and the checkpoint GET resolves; the straggler whose Rule-0 defer collapses *into* the
tiebreak, because earliest-claim-wins makes the pre-existing owner and the minimum the same fact;
and the transient double-claimed and won-but-not-yet-assigned windows the picker's
skip-on-any-assignee absorbs — is ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md)
§2. Read it there; it is not restated here.

Two consequences of that derivation are standing rules, because they get re-litigated: this is
**detect-and-tiebreak, not a kernel mutex** — the comment and assignee APIs offer no conditional
write, so the guarantee is that exactly one of any co-window racer set proceeds and every loser
self-retracts, not single-writer exclusion. And **never fall back to the bare assignee login as an
ownership signal** — that is the degeneracy ADR 0115 removes.

<a id="claim-before-you-assign-a-defer-must-not-strip-the-incumbent"></a>
### Claim before you assign — a defer must not strip the incumbent

The two layers are written in **one order: claim first, assign only on the verb's exit 0.** Every
pipeline agent authenticates as the **same login**, so the assignee is not a per-agent slot — it is
**one shared slot**. Assign-then-claim therefore has no safe back-off: the arriving agent's
self-assign is a no-op on an already-held lane (the slot already shows that login), the verb
correctly defers to the live incumbent, and the arriving agent's cleanup unassign then removes the
**incumbent's** assignment while the incumbent is still working — silently clearing the coarse
availability gate on an issue that is legitimately held (#4015). Claiming first makes that state
unrepresentable rather than merely handled: a deferring agent never assigned, so it has nothing to
undo and mutates nothing. The rule for every writer, stated once here: **never unassign a slot you
did not fill.**

<a id="who-writes-layer-one-the-claim-winner-on-both-paths"></a>
### Who writes layer one — the claim winner, on BOTH paths (#4298)

Layer two has a named writer on every path; layer one did not, and the gap fell exactly on the
**delegated (orchestrated) path**. `write-code` Step 3's orchestrated branch skips the direct-path
block — which carries *both* the claim comment and the self-assign — and the contract never
re-assigned the second half to anybody. The obligation survived only inside one orchestrator's
inline claim-agent prompt, so any other dispatcher (a crew engine threading a token by hand)
satisfied the delegated-claim contract in full while leaving the gate unset. The result was an
issue sitting `status:triaged` **and unassigned** with a finished implementation already open as a
PR — precisely the shape the Step-1 picker selects (observed on #4283 / PR #4295).

**The rule, stated once for every dispatcher: whoever wins the claim writes layer one, immediately
after the win, before it hands the lane on.**

- **Delegated path** — the dispatcher wins the claim pre-spawn, so the **dispatcher** owes layer
  one before it spawns the coder. This binds *every* dispatcher — the orchestrator
  (`.claude/workflows/drive-issue.js`) and any crew engine that claims a lane and threads the
  token — not just the one whose prompt happens to say so.
- **Direct path** — `write-code` wins its own claim at Step 3, so the **coder** owes it there.
- **Either way the coder re-asserts it**, idempotently, once it has confirmed the claim is its own
  (`write-code` Step 3). That re-assert is what makes the gate true **for the whole build**
  whatever the dispatcher did, so Step 8's release can cite it instead of assuming it.

The write goes through **one verb** — never a hand-rolled `gh api … /assignees`:

```bash
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
"$PCLI" claim assign --issue <N>                    # layer one under our own session
"$PCLI" claim assign --issue <N> --session <token>  # …or under the threaded delegated token
```

The verb is the enforcement, not the prose: it resolves ownership through the same **default-deny**
resolution `claim is-mine` uses and **refuses (non-zero, no write) on any lane it cannot prove is
ours** — an absent claim, a foreign owner, and a missing session each refuse. On a proven-own lane
it is **additive and idempotent**: a gate already carrying our login is a no-op, otherwise ours is
added, and the landed gate is read back (a write that did not land fails loud rather than reporting
a gate that isn't there). **It cannot unassign** — there is no removal arm — so "never unassign a
slot you did not fill" holds by construction, and re-running it is always free.

**This is not an inference from absence, and must never become one.** The verb writes the gate
because the run holds the lane, never because a missing assignee was read as evidence that some
other party failed. Nothing here evicts a claim, keys on age, or acts on a marker's absence — the
shapes ADR
[0215](https://github.com/kamp-us/phoenix/blob/main/.decisions/0215-claim-identity-continuity-proof.md)
§5 forbids. **Picker semantics are unchanged**: Step 1 still skips on any non-null assignee and
still does not read claim comments.

**Out of scope here:** *who may release layer two* on the delegated path is a separate, still-open
question (#4145) — this rule settles the other layer and pre-empts none of it.

### Fail-closed on a missing token

If `CLAUDE_CODE_SESSION_ID` is **absent** from the agent's environment, the claim **cannot
be posted** and the agent must **abort the claim** — it never falls back to a login-keyed
marker (the bare assignee is a *coarse availability gate only*, never an ownership claim).
This is the same fail-closed posture every consumer carries: no token ⇒ no claim ⇒ back off,
never mutate unclaimed.

### The pre-spawn claim protocol — claim before the work (ADR 0115 §3)

The claim moves **ahead of work** — the collision window is open while the claim is mid-run,
so closing it means claiming before any branch, build, or spawn:

- **Orchestrated path (the common case).** `.claude/workflows/drive-issue.js` acquires the
  claim in a pre-step **before** the `agent(coder, …)` dispatch (delegated to a thin
  claim-only agent that runs this §7 primitive verbatim): `pipeline-cli tracker claim <N>`
  (the write surface above — defer, post the stamped marker, tiebreak, retract on loss), then
  **write layer one only on a win** (`pipeline-cli claim assign --issue <N>`), and **only on a win
  spawn the coder**, threading the winning claim **token** into the coder's prompt. On a lost claim
  it aborts the dispatch — no coder spawns, and it leaves the assignee untouched (see
  [Claim before you assign](#claim-before-you-assign-a-defer-must-not-strip-the-incumbent)).
  **This binds every dispatcher, not only `drive-issue.js`** — a crew engine that claims a lane and
  threads the token owes layer one on exactly the same terms
  ([Who writes layer one](#who-writes-layer-one-the-claim-winner-on-both-paths)).
- **Delegated ownership.** The orchestrator and the coder are distinct sessions (the spawned
  coder carries `CLAUDE_CODE_CHILD_SESSION=1` and its own id), so the claim token is
  **whoever posted the claim** — the orchestrator. The orchestrator threads its token to the
  coder; `write-code` Step 3 then **recognizes the existing claim as its delegated own** (the
  threaded token equals the earliest authorized claim's session) and proceeds **without
  posting a second, redundant claim** or re-racing.
- **Direct path (no orchestrator).** When `write-code` is invoked directly, its claim is
  made at **Step 3** using the coder's own `CLAUDE_CODE_SESSION_ID` as the token, before it
  branches or builds. Either way the claim precedes the work.

<a id="release-the-claim-ends-when-its-run-does"></a>
### Release — the claim ends when its run does (affirmative, never inferred)

A claim is **held for the duration of the work it protects, and given up when that work is
done**. The owner performs that release itself:

```bash
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
"$PCLI" claim release --issue <N>            # retract our own marker; --session <token> to release a delegated claim
```

**Who calls it, and when.** The run that holds the claim, at its terminus: `write-code` Step 8
(PR open, progress logged, epic handed off) and the end of repair Step R3 (fix pushed, PR handed
back to the gate). Nothing else calls it.

**What it does and refuses to do.** It DELETEs only the `CLAIM_RE` markers carrying the caller's
own token, leaves every other claim standing (and names them), is idempotent (releasing twice
retracts nothing and succeeds), and fails closed with a non-zero exit when there is no token to
prove ownership under. It does **not** touch the **assignee**: the coarse availability gate stays
set while the PR is open, so the Step-1 picker still skips the issue and no second lane picks up
work already in review. That backstop holds because the gate was actually **written** — by the
claim winner on both paths, re-asserted by the coder
([Who writes layer one](#who-writes-layer-one-the-claim-winner-on-both-paths)). Before #4298 the
delegated path wrote no gate at all, so this sentence promised a backstop that was not there.
What release frees is the *fine* resolver — so a **directed** re-dispatch
(a repair, a follow-up round, a stalled lane re-driven) claims the lane cleanly instead of
resolving `lost` against a marker whose run finished hours ago (#3780).

**Release is affirmative — the claim's end is a recorded fact, not an inference from absence.**
This is the load-bearing property, and it is what keeps release outside ADR 0115 §5's deferral:
an owner giving its claim up cannot evict anybody, so none of the eviction risk that deferred
automatic reclaim applies. The inverse must never be built in its place:

- **Never key a release on age.** A TTL evicts a slow-but-live agent — §5's original hazard,
  unchanged.
- **Never key a release on session-id mismatch.** "The claiming session id is not the current
  session id" does **not** mean the work is done: a live process can rotate its session id
  mid-run (#4045), after which the marker names a token the still-working agent no longer
  carries. A rule that evicted on mismatch would evict exactly that live lane. Release is keyed
  on the token the caller **presents**, so a rotated run releases nothing by accident — and an
  operator releasing a delegated or pre-rotation claim passes it explicitly with `--session
  <the token the marker carries>`.
- **Never treat an unreleased claim as released.** A run that crashed before its terminus leaves
  its marker standing; that case is the crashed-agent residual below, not something release
  infers.

### Staleness / reclaim — owner-defer (ADR 0115 §5)

A claim whose agent **crashed** mid-run — dying before it could
[release](#release-the-claim-ends-when-its-run-does) — is **sticky until a human clears it**
(un-assigns the issue / removes the claim, re-opening it to the picker) **unless its claimant is
provably dead** (the next subsection). Automatic **age/TTL-based** reclaim remains an explicitly
deferred follow-up — GitHub exposes no TTL primitive, and an age-keyed reclaim risks evicting
a slow-but-live agent, re-introducing the exact double-implement this design prevents. That
hazard is about *time*, not *liveness*: a claim superseded on **proven claimant death** cannot
evict a live agent, which is why supersession is permitted where a TTL is not.

**Surfacing a stale claim — read it, then clear it by hand.** A claim nothing retracted used to
be invisible; stranded lanes accumulated silently until a dispatch read `lost` and stalled. The
read-only inventory is the surface:

```bash
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
"$PCLI" claim status --issue <N>   # every marker: author, authorization, liveness, and the resolved owner
```

Read it before concluding a lane is stuck. A row with `liveness: dead` is already superseded and
needs nothing. A row with `liveness: unknown` is **indeterminate — it stands**, and clearing it is
a **human's** decision on evidence outside this keyspace (the run's PR landed, the operator knows
the session is gone), never a rule the pipeline applies for you. Clear it by deleting that claim
comment and un-assigning the issue.

**The two claim substrates differ, deliberately — don't read one's rule onto the other.** The
crew tracker's **resource claim** (ADR
[0191](https://github.com/kamp-us/phoenix/blob/main/.decisions/0191-crew-claim-lifecycle.md),
`packages/pipeline-crew-mcp/src/tracker/registry-core.ts`) frees on explicit `releaseClaim` **or
self-reaps** once its holder's presence lease lapses — a stale claim there reads as free. This
**GitHub-marker claim** has no lease to lapse: it frees on an explicit `claim release`, or on
proven claimant death, and otherwise **stands**. So the same lane can read free in the tracker and
held here. That is not a bug to reconcile in passing; the cross-keyspace reconciliation is #3938 /
epic #3766. Until then, the claim your coder actually consults is this one, and "ADR 0191
self-reaping" does **not** govern it.

<a id="dead-claimant-supersession-proven-death-only-adr-0191"></a>
### Dead-claimant supersession — proven death only (ADR 0191 presence liveness)

A claim whose claimant is **provably dead** is **superseded**: it drops out of the
earliest-authorized-claim tiebreak, so the earliest **live-or-indeterminate** authorized claim
is the owner. Without this, a dead session's older marker shadows every later legitimate claim
forever — which made the `write-code` mis-attribution guard *unrunnable* on an orchestrated
repair of an abandoned lane: even an engine that correctly re-claimed the lane in its own
session lost to the dead claimant's earlier marker, so the guard could neither authorize nor
refuse and degraded into a per-agent judgment call (#3751).

Liveness is **presence-derived, never age-derived** (ADR
[0191](https://github.com/kamp-us/phoenix/blob/main/.decisions/0191-crew-claim-lifecycle.md) — a
claim's liveness rides its holder's presence; the same identification `worktree-reap` makes):
the marker's `presence <machine-fingerprint>/<session-pid>` stamp names the claimant's session
process, and a reader on that machine probes it. **Dead requires all three** — a stamp, a match
against a *resolved* local machine fingerprint, and a pid the probe proves gone. Every other state
is **indeterminate and counts as a live claim**: an unstamped/legacy marker, a claim stamped on
another machine, a machine identity this reader cannot resolve, a pid that still resolves, and a
reused pid all leave the claim standing, so the reader refuses. Doubt refuses; it never evicts.

**Liveness is same-host by construction — the honest limit.** The probe is a local pid probe, so
a claim stamped on another machine is unprobeable and stays indeterminate ⇒ it stands and the
reader refuses. That is the correct fail-closed direction, but it means a multi-host crew gets no
supersession at all: every claim it reads was stamped elsewhere. Closing *that* needs a
host-independent liveness source — the crew tracker's own presence keyspace (ADR 0191 proper,
#3938 / epic #3766), whose cross-keyspace reconciliation is where it belongs. Explicitly **out of
scope** for this GitHub-claim keyspace: do not "fix" the multi-host case by treating an
unprobeable claim as dead, which trades a stuck lane for live-claim eviction.

Both the resolution and the probe live in the shared verb — `pipeline-cli claim is-mine`
(default-deny) and `pipeline-cli tracker claim` (which also stops deferring to a dead claimant,
so a legitimate re-claim can land) — never a per-skill re-derivation. The verb prints the
superseded claims next to the resolved owner, so "why is a later claim the owner?" is answerable
from the run log.

### Pre-stamping markers — the one population supersession cannot reach

Supersession needs a stamp to evaluate, so a marker written **before every writer stamped**
(#3987, PR #4015) is permanently indeterminate: it wins the tiebreak forever, and re-claiming
cannot help, because a fresh claim is by definition later than the one shadowing it. Every open
issue holding such a marker is a lane no agent can repair — silently, until a dispatch hits the
mis-attribution guard and (correctly) refuses (#4031).

That population is **bounded** (it predates a fixed instant and only shrinks), so it is cleared
by an audited cleanup, not by a resolution rule — the rules above are untouched, and a **stamped**
claim is never a candidate whatever its age:

```bash
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
"$PCLI" claim audit                 # every open lane held by an unstamped marker, and which are retirable
"$PCLI" claim audit --issue <N>     # the cheap single-lane read when a stall is already known
"$PCLI" claim audit --execute       # retire the retirable ones through `claim release`
```

Retirement runs through **`claim release` under the marker's own token** — the one retraction
mechanism, never a second — and touches a marker only when it is unstamped, predates the stamping
cutoff, has aged past a safety margin, and is the only shape its session left on the lane. Every
other unstamped marker is **reported and held**: an unstamped marker written *after* the cutoff is
a degraded writer (`presence-io.ts` emits no stamp when it cannot read the process table or this
machine's identity), not a legacy one, and may belong to a running agent. No margin *proves* a
claimant is gone, so `--execute` stays an operator act on a report that names each session — never
an automatic sweep, and never a TTL on the resolver.

### Repair dispatches thread the lane's claim token

A **repair** dispatch is the class this contract is easiest to violate on: it lands on a lane
someone else opened, so the earliest authorized claim is by default *not* the repairing run's
session. Every repair dispatcher **MUST** thread the lane's claim token into the coder's prompt
under the same delegated-ownership contract as the initial build (§The pre-spawn claim protocol):
the orchestrator threads the token it claimed pre-spawn; a crew engine re-driving a stalled lane
**claims the lane in its own session first** (`pipeline-cli tracker claim <issue>`, which now
supersedes a dead claimant) and threads *that* token. A repair coder handed no token **refuses**
— deterministically, and not overridably by a coherent-looking dispatch brief (`write-code`
Step R0). There is no repair-specific claim mechanism, and an unthreaded repair is a dispatcher
bug to route back, not an ambiguity for the coder to resolve.

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

## 9. The PR-body closing-keyword seam — one close directive per PR

The single source of the closing-keyword rule, for **both** halves: *arm the seam for the
issue you fix* and *never arm it for any other issue you merely name*. `write-code` Step 5
(authoring + its operational guard) and `ship-it` Step 1 (which resolves the linked issue
from the body) each cite **this** section rather than re-deriving the keyword set or the
discipline, so the two halves can't drift apart (the §CP/§DOC single-sourcing discipline).

**The seam.** A PR body that carries a GitHub **closing keyword** + `#N` auto-closes `#N`
when the PR merges, and only a closing keyword populates `closingIssuesReferences` — the
field `ship-it` Step 1 reads to resolve *which* issue a code-class PR closes. The recognized
closing keywords are, case-insensitive:
`fix`/`fixes`/`fixed`/`close`/`closes`/`closed`/`resolve`/`resolves`/`resolved`. So:

- **Arm it for the target.** Emit a real closing keyword — `Fixes #N` (or
  `Closes #N`/`Resolves #N`) — for the **single** issue the PR closes. A *non*-closing
  mention (`Refs #N`, `Re: #N`, `See #N`, a bare `#N`) renders a timeline cross-reference
  that **closes nothing** and populates **no** `closingIssuesReferences`, so the issue never
  auto-closes on merge and `ship-it` Step 1 finds a code-class PR with no auto-close seam and
  **refuses to merge** it — a verified, merge-ready PR stalls on one wrong token (#647; PR
  #573 shipped `Refs #569` and jammed).

- **Arm it for *nothing else* (the one-close-keyword-per-PR discipline).** A closing keyword
  is a **targeted** directive, emitted for that single target and **nothing else**. *Every
  other* issue you name in the body — a sibling, a related issue, a "see also", a parent-epic
  mention in prose — takes a **non-closing** form: `addresses #M`, `relates to #M`, `see #M`,
  or a bare `#M` with no preceding closing verb. The set of issue numbers preceded by a
  closing keyword anywhere in the body must be **exactly `{N}`**.

**Why prose phrasing is the load-bearing control.** GitHub parses a closing keyword + `#M`
**anywhere** in the body — any line, mid-sentence, any repo the PR can close — as a close
directive; there is **no** "first ref only" or "same line only" exception. So a sibling-ref
`fixes #M` buried in prose **silently auto-closes `#M` on merge** even though the PR never
touched it. This already bit once: PR #1254 (which fixed #1249 and touched only one CSS file)
carried a "Sibling **fixes** #1248…" sentence, GitHub closed the *unfixed* #1248 on merge, and
it was caught only when the next agent went to pick #1248 up and found the work never landed —
the exact silent state corruption that derails lane coordination in an autonomous multi-agent
pipeline (#1259; #1248 was manually reopened).

**Who writes vs reads.** `write-code` Step 5 authors the body to satisfy both halves and runs
the operational pre-push self-check (its `(a)` cross-reference / `(b)` target-seam-armed /
`(c)` no-stray-close-directive grep) — the actionable check lives there. `ship-it` Step 1
reads the armed `Fixes|Closes|Resolves #N` to resolve the linked issue it closes on merge.
Both cite this section as the canonical statement of the rule; neither re-derives it.

### `Part of #N` — the canonical non-closing partial-split marker

The closing-keyword set above auto-closes its target on merge. The **partial-split** case is its
deliberate inverse: a code/skills PR that **advances** an issue while a sibling lane finishes the
rest, so the issue must **stay open** after the PR merges. The canonical marker for that case is a
plain `Part of #N` line — and `Part of` is **not** a GitHub closing keyword, which is exactly why
it fits: a PR that closes nothing on its target carries `Part of #N` instead of a closing
`Fixes #N`.

- **GitHub does not auto-close from it.** `Part of` is absent from the closing-keyword set, so
  GitHub renders a timeline cross-reference but populates **no** `closingIssuesReferences` and
  **does not** auto-close `#N` on merge — the issue stays open for the sibling lane, by construction.
- **`ship-it` Step 1 recognizes it as a valid linked-but-non-closing reference.** Without this, a
  PR that intentionally closes nothing would trip Step 1's "no linked issue" refusal (the seam it
  uses to reject a code-class PR with no auto-close directive). Step 1's relaxed code-class path
  treats a literal `Part of #N` as a legitimate intentional partial-split — merge the PR, leave
  `#N` open — instead of refusing it (the #1342 consumer, landed in PR #1347).

**The prescribing side — a `review-*` verdict's remedy.** The gates are the third party to this
marker: a verdict whose finding is "this PR must stop auto-closing `#N`" prescribes **`Part of #N`**
and nothing else. `Refs #N`, `Re: #N`, `See #N`, and a bare `#N` arm no seam, so a PR that adopts
one hits `ship-it` Step 1's `no linked issue` refusal and becomes unmergeable — the gate's own
advice bricks the lane it gates, silently, since nothing surfaces the refusal until merge time
(#4047, where a `review-code` verdict prescribed `Refs #3943` on PR #3988). The remedy also
**replaces** the closing keyword rather than joining it: a body carrying both `Fixes #N` and
`Part of #N` still auto-closes on the closing keyword. `review-code` carries the operational
statement of this rule ([its Step 4b](review-code/SKILL.md#prescribing-a-linkage-remedy)) and the
other PR gates point at this subsection; the fix for a jammed lane belongs on the advice, never on
Step 1's grammar.

**Single-sourced — producer + consumer + contract, no re-definition.** This marker mirrors the
closing-keyword seam's own single-sourcing: `write-code` Step 5 (the **producer** — emits
`Part of #N` when the PR is an intentional partial-split, the issue staying open for a sibling lane)
and `ship-it` Step 1 (the **consumer** — recognizes it as merge-without-close) each cite **this
section** rather than re-deriving the marker, so the two halves can't drift. The default is still a
closing `Fixes #N` (full close); `Part of #N` is the **explicit** partial-split case. Because
`Part of` is not a closing keyword, it is also invisible to the one-close-keyword-per-PR inverse
guard above — `Part of #N` is never mistaken for a stray closing reference, and a PR that carries
`Part of #N` (and no `Fixes`) has a closing-keyword set of exactly `{}`, which is correct: it closes
nothing.

---

## DEV. The `## Deviations` PR-body disclosure section — one canonical definition

The single source of the deviation-disclosure obligation, for **both** halves: the **writer**
(`write-code` Step 5 composes the section on every PR it opens; its repair round appends to it) and
the **gates** (`review-code`, `review-doc`, `review-skill`, `review-design` each fold it into their
verdict; `review-trivial` bounces any PR that discloses one). Each cites **this** section rather than
re-deriving the classes or the verdict rule, so the five lanes can't drift — the same single-sourcing
discipline §9 and §CP hold.

**The gap it closes.** A departure from the plan, the issue, an acceptance criterion, or a governing
ADR has no required home in the artifact today, so it lives in the coder's session and dies there.
PR [#3986](https://github.com/kamp-us/phoenix/pull/3986) narrowed ADR 0115 §5's reclaim invariant in
skill prose. The author knew — they offered *in review conversation* to file the amending ADR — but
the PR body carried nothing, the offer evaporated, and the narrowing landed on `main` as post-merge
debt that an audit had to reconstruct
([#3993](https://github.com/kamp-us/phoenix/issues/3993) F1; F2 is the same class, a scope note that
omitted a third issue and left half a fix inert). The information existed at authoring time — the
cheapest moment to surface it — and had nowhere to go.

### Shape

```markdown
## Deviations

- **Scope narrowing** — **Said:** #4064's AC asks the gate teeth to cover §6.6's four gates plus
  `review-trivial`. **Did:** `review-trivial` gets a Step-0 bounce, not a deviation verdict.
  **Why:** it emits a trivial-path verdict, and a disclosed deviation is by construction evidence the
  diff is not trivial. **Disposition:** stated in the PR body per the AC; no ADR needed.
```

An entry names four things and nothing more: what the **spec** said (the issue, an acceptance
criterion, a plan, a reviewer's guidance, or the governing ADR — cite it), what the implementation
**did** instead, **why**, and its **disposition** (`no action needed` / `ADR #NNNN amends it` /
`follow-up #M filed` / `for the reviewer to judge`). Lead each entry with its class from the list
below so the gate can match its own finding against your disclosure.

The empty case is an explicit sentence, never an omitted heading:

```markdown
## Deviations

None.
```

### The seven classes — the enumeration is what makes `None.` a claim

A mandatory section that any run can satisfy with `None.` is ceremony. What makes it load-bearing is
that `None.` is a **checked assertion against a closed list**, not a shrug: you wrote it because you
walked these seven and none fired.

1. **Scope narrowing** — the diff delivers less than, or a different shape from, what the issue's
   `### What to build`, a suggested fix-shape, or an acceptance criterion asked. (A `Part of #N`
   partial-split per §9 is a *disclosed* narrowing: name it here too, don't let the token stand in
   for the reasoning.)
2. **Governing-ADR departure** — the implementation contradicts, narrows, or widens an accepted ADR,
   including narrowing an invariant that lives only in skill prose, with no amending ADR in the diff.
   This is the #3986 class.
3. **Known defect left unfixed** — an adjacent or sibling defect you saw and deliberately did not
   fix, whether or not you filed a follow-up.
4. **Declined guidance** — a reviewer suggestion, a reviewer-appended acceptance criterion (§2), or a
   triage instruction you chose not to take.
5. **Guard or gate bypassed** — a `--no-verify` push, a skipped or disabled hook, a suppressed lint
   or type error (`biome-ignore`, `@ts-expect-error`), a skipped / `.only` test, a widened allowlist.
6. **Pre-existing test or fixture changed** — an existing assertion modified, weakened, or deleted
   rather than added to. "It asserted the defect" is a legitimate reason and a mandatory disclosure.
7. **Out-of-scope change** — a file or surface touched that the issue does not imply.

**The classes overlap; the label is a routing hint, not the disclosure.** A change can read as two
classes at once — an addition triage explicitly declined is both class 4 and class 7 — and picking
one is not a mistake to litigate. A gate matches its finding against the entry's **substance** (the
Said / Did / Why), never against the class label, so a mis-labelled but honest entry is disclosed and
a correctly-labelled but vague one is not.

**A falsified `None.` is worse than an honest entry.** When a gate finds a class-N deviation in a
diff whose body says `None.`, the disclosure is a false statement, and the finding is blocking on
*two* counts: the undisclosed deviation, and the fact that the section can no longer be trusted on
this PR. That asymmetry is the section's only real enforcement — disclosing costs a sentence, and a
wrong `None.` costs a repair round.

**Absent is not `None.`** On a PR that **owes** the section (below), a body with no `## Deviations`
heading is malformed: the gate cannot tell "nothing to disclose" from "never considered it", so
absence fails closed (§ZS's posture, applied to a body section). `None.` is a complete, valid
disclosure; silence is not.

### Who owes the section — the one `[N/A]` scoping, stated here and nowhere else

The writer half binds **`write-code`**, so the gate half can only fail a body `write-code` was
obliged to compose. A PR with **no `write-code` author** owes nothing, and its row is **`[N/A]`, not
`[FAIL]`** — every gate that carries the row resolves it by *this* rule. Stated once here on purpose:
carried as a per-skill fragment it diverged immediately, and two gates rendered opposite rows on the
same head — `review-doc` `[N/A]`, `review-code` `[FAIL]` — which, because the verdicts are
conjunctive and `write-code` is not the author, no repair round could ever clear.

A gate resolves the row **`[N/A]` only on positively-established non-obligation**, in exactly two
shapes:

- **The gate's own issueless carve-out already fired.** The row inherits this gate's
  **acceptance-criteria determination**: where the AC half renders N/A because the PR is a blessed
  issueless lane — the conversation-authored `.glossary/**` coining PR of ADR
  [0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md) /
  [0184](https://github.com/kamp-us/phoenix/blob/main/.decisions/0184-review-code-issueless-carve-out.md) —
  the deviation row renders N/A with it. There is no spec to depart from and no `write-code` author
  obliged. Tying the two together is what keeps them from drifting apart again: a gate cannot grade
  ACs while N/A-ing deviations, or the reverse.
- **The PR was not authored by `write-code`.** A bot-opened PR (a dependency bump) or a
  hand-authored human PR never ran Step 5, so its body was never obliged to carry the heading.

Everything else — including a pipeline PR that merely **lost** its `Fixes #N` — is **owed**, and an
absent section is a `[FAIL]`. The exception is deliberately narrow in that direction: dropping the
issue link buys no exemption (each gate already hard-stops that shape as a broken seam), so the only
way to reach `[N/A]` is a carve-out the gate itself established.

**Repair appends, never replaces.** Each repair round adds its entries under the same heading, tagged
`**(repair round K)**`, and leaves the earlier ones standing. The section is a running log of what
this PR departed from across its whole life — rewriting it to the latest round's truth destroys
exactly the trail the incident above wanted.

### Detection tiers — what a gate can actually catch

A gate can only fail what it can observe. These tiers are stated so the obligation is not read as
more enforcement than exists:

- **Tier M — mechanically detectable from the diff.** Class 5's in-diff suppressions
  (`biome-ignore`, `@ts-expect-error`, `test.skip`, `.only`) and class 6's removed assertions in test
  files leave literal tokens in the added/removed lines; a grep over the head diff arms the check
  deterministically. Class 7 is half-mechanical — the changed-path set is machine-readable, but
  "out of scope" is a judgment against the issue's prose.
- **Tier R — reader-detectable.** Classes 1, 2, and 4 need an LLM gate reading the diff against the
  issue, the ADR, and the review threads. The gates already do all three reads (the per-criterion AC
  table, `review-doc` Step 4a's ADR-contradiction sweep, `review-code` Step 3e's unresolved threads),
  so this obligation **reuses** those reads rather than adding a scan.
- **Tier D — disclosure-only, undetectable by any gate.** Class 3 lives entirely in the author's
  head. So does the part of class 5 that leaves no artifact: a `--no-verify` push is invisible
  afterwards — the hooks it skipped left no trace in the diff, the body, or the PR timeline. For
  Tier D no gate can fail an omission. What the obligation buys there is that non-disclosure becomes
  a **rule violation** rather than an oversight, and a later audit has a named place to point at.

**So a `deviation-disclosure: PASS` row means "nothing undisclosed that this gate could see" — never
"no deviations exist."** Gates state it that way in the verdict; a gate that phrases its row as the
stronger claim is overstating its own teeth.

**The canonical Tier-M scan — one snippet, run by every gate that carries the row.** It arms the
check; it never decides it. Emit the scanned scope (§ZS #1) so a drift that silently stops matching
shows in the run log instead of reading green:

```bash
# §DEV Tier M — presence of the section, plus the two diff-detectable classes.
# The section-presence pattern below is the canonical copy; `write-code` Step 5 check (e) and
# `review-trivial` Step 0 restate it mechanically, so a change here has to land in all three (the
# rule is single-sourced, the pattern is not — a silent drift un-gates one lane).
BODY="$(gh api repos/$REPO/pulls/$PR --jq '.body')"
printf '%s' "$BODY" | grep -Eiq '^[[:space:]]*#{2,3}[[:space:]]*Deviations[[:space:]]*$' \
  && echo "deviation-disclosure: ## Deviations section present" \
  || echo "deviation-disclosure: ## Deviations section ABSENT — malformed body if the PR OWES the section (absent is not None.); [N/A] if it does not (see 'Who owes the section')"
# class 5, added suppressions/skips
DEV_SUPPRESS="$(gh pr diff "$PR" | grep -E '^\+' \
  | grep -nE 'biome-ignore|eslint-disable|@ts-(expect-error|ignore)|\.(skip|only)\(|xit\(|xdescribe\(' || true)"
# class 6, removed assertion lines — scoped to TEST files, matching the prose. Walk the diff
# file-by-file so a `--- a/src/assert.ts` header can never match as a removed assertion, and only
# removals inside a test file count. A bare `grep '^-'` over the whole diff matched exactly that
# header (the `-` of `---` plus the word `assert` in the path).
# EVERY file header re-decides the flag, and a DELETED file (`+++ /dev/null`) takes its path from the
# `--- a/<path>` side. Keying only on `+++ b/` left the flag STALE across a deletion, which broke the
# scan in both directions: a deleted non-test file after a test file scored false positives, and a
# deleted test file after a non-test file silently dropped its removed assertions — the exact class-6
# case this scan exists to arm.
DEV_TESTCUTS="$(gh pr diff "$PR" | awk '
  /^--- / { p = $0; next }
  /^\+\+\+ / { t = ((($0 ~ /^\+\+\+ b\//) ? $0 : p) ~ /(\.|\/)(test|spec)\.[a-z]+$|\/(__tests__|test|tests)\//) ; next }
  t && /^-[^-]/ && /expect\(|assert|toBe|toEqual|toThrow/ { print }')"
echo "deviation-disclosure: Tier-M scan — $(printf '%s' "$DEV_SUPPRESS" | grep -c .) suppression/skip line(s), $(printf '%s' "$DEV_TESTCUTS" | grep -c .) removed-assertion line(s)"
```

A hit is a **line to judge against the disclosure**, never a FAIL by itself — a `biome-ignore` the
body discloses with a reason is a passing judgment item, and a legitimately-deleted obsolete test is
not a deviation at all.

### The gate's verdict rule — two branches, mirroring the golden-deviation shape

- **Detected and *not* disclosed ⇒ `[FAIL]` row (blocking).** Name the class, the site, and what the
  spec said, so a repair round can act on it cold. This branch is what makes the section more than
  paperwork.
- **Disclosed ⇒ a judgment item, not an automatic pass.** Verify it on three questions: is it
  **authorized** (does the cited spec actually permit it, or did someone with standing approve it)?
  does it **need an ADR** (a class-2 departure with no amending ADR in the diff is a `[FAIL]` — the
  #3986 remedy)? does it **need a follow-up issue** (a class-3 defect with no filed issue is a
  `[FAIL]`)? A disclosed deviation that answers all three is a PASS row, cited.
- **Absent section ⇒ `[FAIL]` row on a PR that owes it**, per *Absent is not `None.`* above — and
  **`[N/A]` on one that does not**, per *Who owes the section*. Resolve the owed/not-owed question
  first; it is the only branch that decides between those two rows.

This is deliberately the same escalate-to-judgment shape `review-design`'s golden-deviation class
already runs (an *unexplained* deviation from a blessed golden hard-FAILs; an explained one is
judged, [review-design/SKILL.md](review-design/SKILL.md) calibration B, #2945) — one reviewing idiom,
two surfaces, so neither has to be learned separately.

### Who writes vs reads

| Half | Surface | Obligation |
|---|---|---|
| Writer | `write-code` Step 5 (open), repair Step R3 (append) | Emits the section on every PR; `None.` only after walking the seven classes |
| Gate | `review-code` Step 3g, `review-doc` Step 4c, `review-skill` Step 4c, `review-design` Step 3b | Folds one `deviation-disclosure` row into its conjunctive table by the rule above — `[N/A]` where *Who owes the section* says the PR owes nothing |
| Gate | `review-trivial` Step 0 | A non-`None.` section is evidence the diff is not trivial ⇒ route to the full path; an absent section is unprovable-premise ⇒ route to the full path, where the owed/not-owed branch resolves it |

The rationale lives in ADR
[0216](https://github.com/kamp-us/phoenix/blob/main/.decisions/0216-deviation-disclosure-is-a-pr-body-obligation.md).

---

## Relationship between the formats

| Format | Lives on | Written by | Read by |
|---|---|---|---|
| `## Dependencies` grammar | epic body | plan-epic | review-plan, write-code |
| Sub-issue body | each sub-issue | plan-epic | review-plan, write-code, review-code |
| Sub-issue AC — reviewer-append surface (§2) | each sub-issue's `### Acceptance criteria` | review-code, review-doc, review-skill, review-plan (append-only, ACL-gated, ADR 0079) | write-code (drains), review-* (verifies) |
| Pitch (§PITCH) | lane-entering issue body + its `pitch-approved:` comment | triage (drafts the body section), the **founder** (the approval comment — never an agent) | write-code, pitch-guard, the appetite breaker (#3966), the cycle heartbeat (#3948) |
| Progress comment | the worked issue | write-code | write-code (successor) |
| Epic handoff note | parent epic | write-code | write-code (siblings) |
| review-code PASS marker | the PR | review-code | ship-it |
| review-code FAIL marker | the PR | review-code | write-code (fix round-trip) |
| review-doc PASS marker | the PR | review-doc | ship-it |
| review-doc FAIL marker | the PR | review-doc | write-code (fix round-trip) |
| review-skill PASS marker | the PR | review-skill | ship-it |
| review-skill FAIL marker | the PR | review-skill | write-code (fix round-trip) |
| `## Deviations` section (§DEV) | the PR body | write-code (Step 5 opens it, repair R3 appends) | review-code, review-doc, review-skill, review-design (verdict row), review-trivial (triviality bounce) |
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

The **zero-scope=fail invariant** (§ZS) is the one convention that is **not** a format but
a *behavioral contract every gate honors*: `review-code`/`review-doc`/`review-skill`,
`ship-it`, the epic-ledger validators (`review-plan`), and the CI cycle/convention checks
each cite §ZS rather than re-deriving emit-scope + fail-closed-on-zero-match. Its first
adoption is the epic-ledger floor — `validateLedger`'s `ZERO_SCOPE` defect fails a childless
epic closed, and the `review-plan` gate verdict emits the scanned child count — so the
convention ships demonstrated, not just stated (ADR 0092).
