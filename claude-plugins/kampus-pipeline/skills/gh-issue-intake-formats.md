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
**unmilestoned** cluster (e.g. a frozen new-product surface — kampus-CLI / künye) is itself
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
first-class, correct state (exactly as a missing `milestone` is in §Milestone), not a defect to
repair.

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
  established facts, newest last, each a one-line entry naming *what was decided/found* and the
  frontier ticket it came from (`— from #N`). This is the map's growing spine of certainty; a
  **work** run appends to it as it resolves each frontier ticket. Nothing is ever deleted here —
  a decision that is later revisited gets a new superseding entry, so the log stays auditable.
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

Here `#101`/`#102` have graduated (their answers are in `## Decisions-so-far`, they sit in
`## Graduated fog`, and each spawned the next frontier ticket), `#103` is an answerable
investigation `work` mode can clear, and `#104` is a **founder-decision-fork** `wayfinder`
surfaces and stops on — never auto-resolves.

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

So every gate that posts a verdict marker — `review-code`, `review-doc`, `review-skill` — closes the
loop with **one** canonical read-back guard: after the post/upsert lands, **re-read the comment you
just wrote** and assert three invariants, failing **loud** (fail-closed, ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md) §ZS)
on any miss — never a silent pass. This is the single source; each review skill **references it**
(it does not re-derive its own copy — the three-copy drift is exactly what this contract exists to
prevent):

```bash
# verdict_readback_guard <comment-id> <gate> <head-sha>: re-read the just-posted verdict comment
# and PROVE it is a well-formed, leak-free, current-head-bound marker. FAIL LOUD (non-zero) on any
# miss — a broken marker reads to consumers as "no verdict", or worse a human skims it as posted.
# <gate> is one of: review-code | review-doc | review-skill.
verdict_readback_guard() {
  local cid="$1" gate="$2" sha="$3"
  local got; got="$(gh api "repos/$REPO/issues/comments/$cid" --jq .body)" || {
    echo "verdict_readback_guard FAILED: cannot re-read comment $cid — treat the verdict as UNLANDED." >&2; return 1; }

  # (0) the body is non-empty. An empty/whitespace-only body carries no marker at all — the degenerate
  #     case of a garbled post (#2268); reject it up front so the failure names the real cause rather
  #     than falling through to (1)'s "no marker".
  if [ -z "$(printf '%s' "$got" | tr -d '[:space:]')" ]; then
    echo "verdict_readback_guard FAILED: comment $cid is empty/whitespace — no verdict landed; the PR is UNGATED." >&2; return 1
  fi

  # (1) the canonical gate marker token is present: either the bindable first-line
  #     `<gate>: PASS|FAIL @ <sha>` (SHA prefix-matched, ADR 0058), OR the SHA-less `<gate>: advisory`
  #     first line (blocking-set path — authorizes nothing but IS a posted verdict).
  printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*(PASS|FAIL)[[:space:]]*@[[:space:]]*${sha:0:7}" \
    || printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*advisory" \
    || { echo "verdict_readback_guard FAILED: no canonical '${gate}:' marker (PASS/FAIL @ ${sha:0:7} or advisory) in comment $cid — the body is malformed; the PR is UNGATED." >&2; return 1; }

  # (2) Head binding — SHA-SOURCE-AWARE (#2272), and every verdict body binds the reviewed head:
  #     - a bindable first line (`<gate>: PASS|FAIL @ <sha>`) carries the binding inline — (1) already
  #       validated it against ${sha:0:7}, so a non-blocking binding PASS/FAIL needs no separate line
  #       (this is the branch that keeps a legitimate non-blocking PASS from false-failing; #2272).
  #     - a SHA-less advisory first line (`<gate>: advisory`, ALL FOUR gates INCL review-code) MUST
  #       carry the canonical body `Reviewed-head: @ <sha>` line (§6.6 / ADR 0151) — absence is FATAL.
  #       (#2329: the prior "review-code's §CP advisory carries NONE by design → accept its absence"
  #       carve-out contradicted §6.6's own MUST and blinded the read-back to a drifted
  #       `**Reviewed head:**` variant — bold, space-not-hyphen, backticked SHA — that does NOT match
  #       `^Reviewed-head:` and that ship-it's §6.6 enqueue matcher then rejects, leaving a genuinely
  #       -approved §CP PASS silently unshippable until a human hand-re-posts. Requiring the canonical
  #       line on every advisory makes a drifted line read as absent → FATAL here → forces a canonical
  #       re-post at EMISSION time, never a ship-it refusal on an approved PR.)
  #     - ANY `Reviewed-head:` line present (advisory, or a belt-and-suspenders non-blocking PASS) must
  #       bind ${sha:0:7} — a mis-bound/stale one is ALWAYS fatal (a wrong head must never read verified).
  if printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*(PASS|FAIL)[[:space:]]*@[[:space:]]*${sha:0:7}"; then
    : # bindable first line: its `@ <sha>` IS the head binding (validated by (1))
  elif ! printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:"; then
    echo "verdict_readback_guard FAILED: SHA-less advisory in comment $cid carries no canonical 'Reviewed-head: @ ${sha:0:7}' line — §6.6/ADR 0151 requires it on ALL four gates' advisories (incl review-code); a drifted '**Reviewed head:**' variant reads as absent. Re-post the canonical 'Reviewed-head: @ <sha>' line (hyphen, no bold, no backticks around the SHA)." >&2; return 1
  fi
  # a present `Reviewed-head:` line (advisory OR a non-blocking PASS that also carries it) must bind head:
  if printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:"; then
    printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:[[:space:]]*@?[[:space:]]*${sha:0:7}" \
      || { echo "verdict_readback_guard FAILED: 'Reviewed-head:' line in comment $cid is bound to the wrong head (not @ ${sha:0:7}) — a stale/mis-bound head binding." >&2; return 1; }
  fi

  # (3) NO local filesystem path leaked into the public body (the #2148/#2268 leak). Reject a
  #     machine-local scratch/home path or a leading `@<path>` marker-as-path. Match by absolute ROOT
  #     (`/Users`, `/var`, `/tmp`, `/private`) — the roots a `mktemp`/scratchpad path lands under —
  #     not just `/var/folders/`, so a leaked path under any of them cannot read green (#2268). Patterns
  #     are placeholders, not real paths — this doc stays leak-clean.
  if printf '%s' "$got" | grep -Eq '(/var/|/Users/|/tmp[/.]|/private/|(^|[[:space:]])~/|(^|[[:space:]])@/)'; then
    echo "verdict_readback_guard FAILED: comment $cid leaks a local filesystem path in its body — a #2148/#2268 marker-as-path leak; refuse and re-post the real verdict." >&2; return 1
  fi

  echo "verdict_readback_guard OK: ${gate} verdict @ ${sha:0:7} landed on comment $cid — marker + head binding valid, no local-path leak."
}
```

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
# verdict_post_verify <PR> <gate> <head-sha>: the UNCONDITIONAL post-verification, run after ANY
# verdict post/upsert (native APPROVE, comment PATCH-upsert, comment POST, advisory). It does NOT
# rely on a $MINE/$CID captured on one posting branch — it RE-SCANS the PR's live state to resolve
# whatever landed, then proves it well-formed + leak-free. Returns 0 ONLY on a proven-clean landed
# verdict; non-zero (FATAL) on absent / malformed / leaking. <gate> ∈ review-code|review-doc|review-skill.
verdict_post_verify() {
  local PR="$1" gate="$2" sha="$3" me cid approved rbody
  me="$(gh api user --jq .login)"
  # (A) resolve MY landed marker COMMENT id for this gate — the SHA-bound `<gate>: PASS|FAIL @ <sha>`
  #     first line OR the SHA-less `<gate>: advisory` line — re-scanned from PR state, NOT a carried id.
  #     A whole-body-path leak (#2264) has NO `<gate>:` first line, so it resolves empty here → caught in (C).
  cid=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100" \
    | jq -r --arg me "$me" --arg g "$gate" --arg sha "${sha:0:7}" '
        [ .[] | select(.user.login==$me)
              | select((.body | test("^\\s*\\**\\s*" + $g + ":\\s*(PASS|FAIL)\\s*@\\s*" + $sha; "i"))
                        or (.body | test("^\\s*\\**\\s*" + $g + ":\\s*advisory"; "i"))) ]
        | sort_by(.created_at) | last | .id // empty')
  # (B) or a native approving REVIEW GitHub bound to this exact head (commit_id == head; its own SHA anchor):
  approved=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq "[.[] | select(.user.login==\"$me\" and .commit_id==\"$sha\" and .state==\"APPROVED\")] | length")
  rbody=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq "[.[] | select(.user.login==\"$me\" and .commit_id==\"$sha\" and .state==\"APPROVED\")] | last | .body // empty")
  echo "verdict_post_verify: PR #$PR ${gate} @ ${sha:0:7} -> comment=${cid:-none} native-approve=${approved:-0}"

  # (C) FATAL: nothing bound to this head landed — the post no-opped, OR the body carries no marker
  #     line at all (the #2264 whole-body-path leak leaves no `<gate>:` first line). The PR is UNGATED.
  if [ -z "$cid" ] && [ "${approved:-0}" -eq 0 ]; then
    echo "verdict_post_verify FAILED (fatal): no ${gate} verdict bound to head ${sha:0:7} landed on PR #$PR — the post no-opped or the marker's first line is absent (a whole-body local-path leak leaves no marker). Re-post the real by-value verdict; if it still cannot land, report a POSTING FAILURE — the PR is ungated." >&2
    return 1
  fi

  # (D) UNCONDITIONAL shape + leak read-back on the landed COMMENT — covers PATCH-upsert, POST, and
  #     advisory (every comment post path). $cid came from a re-scan, so this runs no matter which
  #     branch posted; the guard asserts marker shape + `Reviewed-head:` + NO local-path leak.
  if [ -n "$cid" ]; then
    verdict_readback_guard "$cid" "$gate" "$sha" || {
      echo "verdict_post_verify FAILED (fatal): landed ${gate} comment $cid on PR #$PR is malformed or leaks a local filesystem path — delete/re-post the real by-value verdict and re-verify; never leave a broken/leaking marker." >&2
      return 1
    }
  fi

  # (E) UNCONDITIONAL leak check on the native-APPROVE body too. The APPROVE body is by-value, but a
  #     hand-assembled body could still carry a local path; its SHA binding is the commit_id, so ONLY
  #     the leak check applies (no `Reviewed-head:` line is required of a native approve). LINEAR regex
  #     (literal alternation + anchored `(^|[[:space:]])` — no nested quantifier, no ReDoS), the same
  #     pattern verdict_readback_guard uses; paths are placeholders, keeping this doc leak-clean.
  if [ "${approved:-0}" -gt 0 ] && [ -n "$rbody" ]; then
    if printf '%s' "$rbody" | grep -Eq '(/var/|/Users/|/tmp[/.]|/private/|(^|[[:space:]])~/|(^|[[:space:]])@/)'; then
      echo "verdict_post_verify FAILED (fatal): native APPROVE review body on PR #$PR leaks a local filesystem path — dismiss/re-post a clean by-value verdict." >&2
      return 1
    fi
  fi

  echo "verdict_post_verify OK: ${gate} verdict @ ${sha:0:7} landed clean on PR #$PR (comment=${cid:-none} native-approve=${approved:-0}) — present, well-formed, leak-free."
}
```

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

**The control-plane / blocking set is, exactly:**

- `.claude/**` — the agent control plane (instructions, tools, hooks).
- `.github/**` — CI enforcement.
- the **gate-critical skills** — the verification/merge machinery plus the shared marker
  contract they all depend on:
  - `claude-plugins/kampus-pipeline/skills/ship-it/**`
  - `claude-plugins/kampus-pipeline/skills/review-code/**`
  - `claude-plugins/kampus-pipeline/skills/review-doc/**`
  - `claude-plugins/kampus-pipeline/skills/review-skill/**`
  - `claude-plugins/kampus-pipeline/skills/review-design/**`
  - `claude-plugins/kampus-pipeline/skills/review-plan/**`
  - `claude-plugins/kampus-pipeline/skills/review-trivial/**` — the trivial-diff gate emits
    SHA-bound, merge-consumed verdicts, so it is gate-critical exactly like the other reviewers;
    its omission was a live fail-**open** §CP-bypass (ADR
    [0174](https://github.com/kamp-us/phoenix/blob/main/.decisions/0174-bare-sh-guards-control-plane-gate.md), #2679).
  - `claude-plugins/kampus-pipeline/skills/triage/**`
  - `claude-plugins/kampus-pipeline/skills/write-code/**`
  - `claude-plugins/kampus-pipeline/skills/plan-epic/**`
  - `claude-plugins/kampus-pipeline/skills/release/**` — the release machinery (ADR 0174, #2679).
  - `claude-plugins/kampus-pipeline/skills/**/*.sh` — every skill shell helper, at **any depth**
    under `skills/`: the bare gate-critical guard scripts directly under `skills/`
    (`validate-gate-path-drift.sh`, `validate-skills.sh`, `validate-cycle-*.sh`) **and** a helper
    nested in a skill subdir (`report/footer.sh` — its `Filed by an agent` provenance marker feeds
    triage's ADR-0159 auto-close eligibility; `doctor/doctor.sh`): executable enforcement that
    feeds or runs the gates, control-plane *by nature* like the guard packages. The
    `^claude-plugins/kampus-pipeline/skills/([^/]+/)*[^/]+\.sh$` branch classifies them (ADR
    [0174](https://github.com/kamp-us/phoenix/blob/main/.decisions/0174-bare-sh-guards-control-plane-gate.md), #2576/#2950);
    the leaf `[^/]+\.sh$` matches a `.sh` filename and `([^/]+/)*` the intervening dirs, so it owns
    a shell helper wherever it sits without reaching the non-`.sh` files in the skill *dirs* above.
  - `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` (this file)

  **Deliberately OUT of §CP** (recorded so their absence is a decision, not an oversight): the
  `heal-ci`, `what-shipped`, `doctor`, and `wayfinder` skills are operational diagnostics /
  reporting / orientation — they neither gate a merge nor hold release authority nor sit on a
  gate-critical path, so they auto-merge on a `review-skill` PASS like any ordinary skill. Do
  **not** add them to the boundary (ADR 0174).
- the **pipeline agent definitions** — `claude-plugins/kampus-pipeline/agents/**`: the behavior
  instructions for the very agents that run the pipeline, including `shipper.md` (the merge
  authority) and `reviewer.md` (the verdict gate). An agents-only PR matched **no** §CP clause
  and **no** routing probe, so `ship-it` would have enqueued it with no human merge and no gate —
  a gate/merge agent auto-shipping a weakening of its own instructions, the exact
  self-modification-of-guardrails risk §CP exists to prevent (ADR
  [0150](https://github.com/kamp-us/phoenix/blob/main/.decisions/0150-control-plane-covers-pipeline-agent-defs.md),
  #2003; same ADR 0065 rationale that makes the gate-critical skills blocking). Agent defs are
  behavioral artifacts like skills → **`review-skill`-routed for the verdict**, **blocking for merge**.
- the **plugin hook surface** — `claude-plugins/kampus-pipeline/hooks/**` (the `install.sh`
  that drops the installed `pipeline-cli` and the `guard.sh` fail-open dispatch wrapper) plus
  `claude-plugins/kampus-pipeline/hooks.json` (the foreign-repo hook manifest). These are
  self-weakening by nature — they wire the guard dispatch + the CLI install the `.claude/settings.json`
  hooks depend on (ADR [0103](https://github.com/kamp-us/phoenix/blob/main/.decisions/0103-consolidate-pipeline-cli-package.md),
  #1003). The `^claude-plugins/kampus-pipeline/hooks(/|\.json$)` clause covers the dir + the manifest.
- the **enforcement-guard packages** — the executable guardrails that gate agent tooling,
  control-plane *by nature* the same way the gate-critical skills are (ADR
  [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md)),
  even though they live under `packages/` rather than `.claude`/skills (ADR
  [0100](https://github.com/kamp-us/phoenix/blob/main/.decisions/0100-control-plane-covers-enforcement-guard-packages.md)):
  - `packages/ci-required/**` — the zero-dep aggregator of the gating CI checks; the ADR-0092
    special-case kept as its own package (its CI job still runs `node packages/ci-required/src/bin.ts`).
  - `packages/pipeline-cli/**` — the consolidated guard machinery (ADR
    [0103](https://github.com/kamp-us/phoenix/blob/main/.decisions/0103-consolidate-pipeline-cli-package.md)),
    now the single home for every guard the standalone `*-guard` packages used to carry
    (`spawn-guard`, `worktree-guard`, `structured-output-guard`, `leak-guard`),
    those packages deleted by Phase-4 (#1003). The whole package matches (`^packages/pipeline-cli/`),
    not a `src/guards/` sub-prefix: the shared guard-dispatch infra — `registry.ts` (the
    `registeredTools[]` array that wires every guard in), `router.ts`/`bin.ts` — lives at the
    **package root**, so an edit there could disable or bypass every guard. The whole package is
    a self-weakening surface. The legacy `^packages/[^/]*-guard/` clause is now retired with those
    packages; guard coverage flows through `^packages/pipeline-cli/`.

A PR touching **any** path in this set is **control plane**: `ship-it` refuses to auto-merge
it and a human merges it by hand (ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md),
widened to the gate-critical skills by ADR
[0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md);
`review-skill/**` added to the gate-critical set by ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md), since the gate
that reviews the gates is itself a gate; the enforcement-guard packages added by ADR
[0100](https://github.com/kamp-us/phoenix/blob/main/.decisions/0100-control-plane-covers-enforcement-guard-packages.md),
since a guard is a self-weakening surface wherever it lives; that coverage now also flows
through the consolidated `^packages/pipeline-cli/` package per ADR
[0103](https://github.com/kamp-us/phoenix/blob/main/.decisions/0103-consolidate-pipeline-cli-package.md);
the **pipeline agent definitions** (`claude-plugins/kampus-pipeline/agents/**`) added by ADR
[0150](https://github.com/kamp-us/phoenix/blob/main/.decisions/0150-control-plane-covers-pipeline-agent-defs.md),
since a gate/merge agent's own instructions are a self-weakening surface; the **bare gate-critical
`.sh` guards** under `skills/` and the **`release`/`review-trivial` skill dirs** added by ADR
[0174](https://github.com/kamp-us/phoenix/blob/main/.decisions/0174-bare-sh-guards-control-plane-gate.md)
(#2576/#2679), since a guard script and a SHA-bound-verdict gate are self-weakening surfaces that
were escaping the boundary; the **lint/GritQL governance config** — `biome.jsonc` and
`biome-plugins/**` — added by ADR
[0193](https://github.com/kamp-us/phoenix/blob/main/.decisions/0193-lint-governance-config-is-control-plane.md),
since an ungated path to weaken a lint rule is a guard-relaxing vector). Everything else — `apps/**`,
**non**-guard `packages/**`, `.decisions/**` (**except a guard-touching ADR** — see the content
clause below), `.patterns/**`, every prose doc `*.md` (the
§DOC class), and every **non**-gate-critical `skills/**` — is **non-blocking** and
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
CONTROL_PLANE_RE='^(\.claude|\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan|triage|write-code|plan-epic|release|review-trivial)/|^claude-plugins/kampus-pipeline/skills/([^/]+/)*[^/]+\.sh$|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\.md$|^claude-plugins/kampus-pipeline/hooks(/|\.json$)|^packages/ci-required/|^packages/pipeline-cli/|^biome\.jsonc$|^biome-plugins/'
# --paginate + a STREAMING --jq ('.[].filename', one line per file) is the canonical pattern: gh
# concatenates the per-page element streams, so grep aggregates §CP matches across ALL pages. The
# API caps per_page at 100 regardless of the value, so a single non-paginated call truncates a
# >100-file PR — hiding a control-plane file in the tail. Never pair --paginate with an AGGREGATE
# --jq (`[ … ]` / `length` / `add`): gh runs the filter PER PAGE and emits one result each (#725).
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | grep -Eq "$CONTROL_PLANE_RE" && echo "BLOCKING — control plane (manual merge)"
```

**The §CP-deciding consumers resolve this line from `origin/main` at run time, not from the
copy embedded in their own skill body.** A skill runs against the **snapshot injected into the
agent's context at invoke time**, which can lag `origin/main` even when the on-disk copy in the
same worktree is current — so an agent on a pre-amendment snapshot once auto-merged a
now-control-plane PR the *current* boundary marks human-merge-only (#981). The fix makes the
single source authoritative **at run time**: `ship-it` Step 0 and `review-code` Step 2 read the
`CONTROL_PLANE_RE` line from this file on `origin/main` (REST raw, `?ref=main`) and classify
against *that*, **failing closed** — every path treated as control-plane, so the gate refuses —
if the read can't be made, never falling back to the possibly-stale snapshot. The embedded copy
each consumer still carries is the fail-closed reference and the `validate-gate-path-drift`
lockstep target; it is **not** the live decision source. This makes ADR 0073 §6's "single
definition" hold across snapshot age, not just on disk.

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

The predicate is **single-sourced here** as one canonical regex — the same discipline that keeps
`CONTROL_PLANE_RE` from drifting (ADR 0073 §6). Cite this line; do **not** re-hard-code the
vocabulary. `validate-gate-path-drift.sh` locks `ship-it`'s copy byte-identical to this canonical.

```
GUARD_ADR_RE='guard|invariant|fail-closed|fail-open|fail closed|fail open|containment|control-plane|control plane|§cp|self-weakening|blocking set|adversarial review|must never|hard-gate|hard gate|enforcement|\bgat(e|es|ing|ed)\b|relax|loosen|weaken|soften|widen|broaden|waive|bypass|exempt|carve[ -]?out|opt[ -]?out'
```

```bash
# §CP content clause (ADR 0164): a touched .decisions/** ADR whose CONTENT matches GUARD_ADR_RE is
# §CP. Resolve GUARD_ADR_RE from origin/main at run time (like CONTROL_PLANE_RE, #981); read each
# ADR's body at the PR head. FAIL CLOSED: an unreadable boundary ⇒ match-everything; an unreadable
# ADR (delete/404) ⇒ §CP — never auto-ship an ADR that could not be read and proven guard-free.
GUARD_ADR_RE='guard|invariant|fail-closed|fail-open|fail closed|fail open|containment|control-plane|control plane|§cp|self-weakening|blocking set|adversarial review|must never|hard-gate|hard gate|enforcement|\bgat(e|es|ing|ed)\b|relax|loosen|weaken|soften|widen|broaden|waive|bypass|exempt|carve[ -]?out|opt[ -]?out'
GA_LIVE="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null | grep '^GUARD_ADR_RE=' | head -n1 || true)"
if [ -n "$GA_LIVE" ]; then GUARD_ADR_RE="$(printf '%s' "$GA_LIVE" | sed "s/^GUARD_ADR_RE='//; s/'$//")"; else GUARD_ADR_RE='.'; fi   # FAIL CLOSED: '.' ⇒ every ADR word matches ⇒ every touched ADR is §CP
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
echo "$FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
  [ -z "$adr" ] && continue
  body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
  if [ -z "$body" ]; then echo "BLOCKING ($adr — unreadable at head ⇒ §CP, fail-closed)"
  elif printf '%s' "$body" | grep -Eiq "$GUARD_ADR_RE"; then echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)"; fi
done
```

A guard-touching ADR classifies **§CP for merge-authority** exactly like a path-§CP file:
`ship-it` STOPS at `awaiting control-plane approval` until a current-head `@kamp-us/control-plane`
approval is present (per POLICY, the founder's; ADR 0135). Its **verdict routing is unchanged** —
it is still doc-class, `review-doc`-verified (this set governs *who merges*, not *which gate
verifies*); the content clause adds only the merge-authority hold.

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

So these probes are **single-sourced here** as canonical named `_RE=` lines — the same
discipline that single-sources `CONTROL_PLANE_RE`/`GUARD_ADR_RE` (§CP) and `UI_RE`
(`ship-it/SKILL.md`). A third inline copy in `reviewer.md` is the exact drift `#375`/`#981`/`#2341`
fought — the class probes were previously inline grep literals in `ship-it` Step 0 *only*, with
no reusable line for the reviewer to consume:

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
ruling — extras don't block — is preserved; the class fix and the §CP ruling compose).

**Both consumers re-resolve these lines from `origin/main` at run time** (REST raw, `?ref=main`
— the #981 idiom, generalized from `CONTROL_PLANE_RE`/`UI_RE` to the class probes), never trusting
the injected skill snapshot, which can lag `origin/main` even when the on-disk copy is current.
The re-resolution is **fail-closed**: an unreadable source ⇒ **dispatch the gate** (never silently
skip a class) — `HAS_CODE_RE`/`HAS_SKILLS_RE`/`HAS_DOCS_RE` default to `.` (every path matches),
`HAS_DOCS_EXCLUDE_RE` defaults to a never-match sentinel (`$^`, so the carve-out excludes nothing
and every path falls through to the doc test). This is the same stance as §CP's fail-closed
`CONTROL_PLANE_RE='.'` and `UI_RE`'s fail-closed `has-ui`:

```bash
# Re-resolve a canonical _RE= line from gh-issue-intake-formats.md@main (#981 ?ref=main idiom).
# Prints the live value, or the fail-closed default $2 when the line is unreadable.
FORMATS_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
reresolve_re() {   # $1=var name, $2=fail-closed default
  live="$(printf '%s\n' "$FORMATS_RAW" | grep "^$1=" | head -n1 || true)"
  if [ -n "$live" ]; then printf '%s' "$live" | sed "s/^$1='//; s/'\$//"; else printf '%s' "$2"; fi
}
HAS_CODE_RE="$(reresolve_re HAS_CODE_RE '.')"
HAS_SKILLS_RE="$(reresolve_re HAS_SKILLS_RE '.')"
HAS_DOCS_EXCLUDE_RE="$(reresolve_re HAS_DOCS_EXCLUDE_RE '\$^')"   # fail-closed: exclude NOTHING ⇒ every path reaches the doc test
HAS_DOCS_RE="$(reresolve_re HAS_DOCS_RE '.')"                     # fail-closed: every path is a doc
```

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
# iso_preflight <surface>: the shared primary-checkout fail-closed guard every head-materializing
# gate runs BEFORE its first head fetch / `git worktree add` (§RO). Reviewer/shipper sibling of
# write-code's Step-4 wt_preflight (ADR 0172) — the SAME git-dir==common-dir detection, the SAME
# isolation-expected fork. Read-only (git rev-parse only); safe to re-run.
iso_preflight() {
  local surface="$1" gitdir common iso=0
  gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
    echo "$surface iso_preflight FAILED (fail-closed): not inside a git repository — refusing to materialize a PR head." >&2; return 1; }
  common="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac   # normalize a relative `.git` (older git)
  common="$(cd "$common" && pwd)"
  # Isolation was EXPECTED when the run is under an isolation-asserting pipeline agent-type —
  # coder/reviewer/shipper all spawn isolation:worktree (agents/{coder,reviewer,shipper}.md) — read
  # from the harness-set $CLAUDE_CODE_AGENT (stable across an agent's Bash calls, unlike a shell
  # export), corroborated by a set $WORKTREE_ROOT. A genuine standalone run (a human /review-code,
  # /ship-it) matches NEITHER. Critically the LOUD refusal fires on the AGENT-TYPE ALONE and does
  # NOT key on $WORKTREE_ROOT being set — so the #2440 no-op (isolation requested, $WORKTREE_ROOT
  # unset, which also disarms the $WORKTREE_ROOT-keyed worktree-guard) still trips this preflight;
  # it is then the sole surviving layer, exactly as in write-code (ADR 0172).
  case "$CLAUDE_CODE_AGENT" in coder|*coder*|reviewer|*reviewer*|shipper|*shipper*) iso=1 ;; esac
  [ -n "$WORKTREE_ROOT" ] && iso=1
  echo "$surface iso_preflight: git-dir=$gitdir common-dir=$common cwd=$(pwd) isolation-expected=$iso (agent=${CLAUDE_CODE_AGENT:-unset} worktree-root=${WORKTREE_ROOT:+set})"
  if [ "$gitdir" = "$common" ]; then
    if [ "$iso" = 1 ]; then
      echo "$surface iso_preflight FAILED (fail-closed, LOUD): worktree isolation was EXPECTED (agent=${CLAUDE_CODE_AGENT:-?}, worktree-root=${WORKTREE_ROOT:+set}) but this run is on the PRIMARY checkout (git-dir == common-dir) and \$WORKTREE_ROOT is unset." >&2
      echo "  Refusing to fetch / \`git worktree add\` the PR head here — the #2440 harness no-op left this $surface spawn in the shared primary checkout, and a head-materialization run there is the #2452/#2453 primary-checkout-detach surface. The \$WORKTREE_ROOT-keyed repo-side worktree-guard is disarmed by the same no-op, so THIS preflight is the only surviving layer." >&2
      echo "  Do NOT self-provision a worktree to route around it — that hides the harness failure and leaves the primary-corruption defense collapsed to one, invisibly (#2270)." >&2
      echo "  ROUTED BLOCKER — surface UP to the operator/EM: 'harness worktree provisioning no-op'd for a $surface spawn (isolation expected, \$WORKTREE_ROOT unset); the out-of-repo harness half (#2440) needs attention. Do NOT blindly retry the same spawn.'" >&2
      return 1
    fi
    # isolation NOT expected ⇒ a genuine standalone run on the owner's primary checkout. This gate
    # never mutates the launched tree (§RO): it materializes the head ONLY into a throwaway worktree
    # / per-run ref, so operating from the primary checkout is safe here — proceed, no LOUD stop.
    echo "$surface iso_preflight: standalone run on the primary checkout — proceeding read-only via the §RO throwaway-worktree / per-run-ref materialization (the launched tree is never mutated)." >&2
  fi
}
```

The fork is what keeps this **non-breaking for a legitimate standalone gate**: §RO explicitly
runs a gate "in a checkout it does not own — often the owner's live checkout," and that
standalone-on-primary mode stays allowed (the gate's materialization is throwaway-only). The
LOUD stop fires **only** for an isolation-expected pipeline spawn that mis-landed on the primary
checkout — the exact #2440/#2453 condition. `write-code`'s Step-4 `wt_preflight` is the stricter
sibling (it *always* expects isolation and additionally must branch the session tree, so it also
refuses the standalone-on-primary case via its Non-isolated fallback); it is a deliberate,
documented specialization of this same contract, not a fourth drifting copy.

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

1. **Resolve the live head SHA up front, via REST/porcelain — never GraphQL** (§Target repo
   resolution / the all-`gh api` rule). This is the SHA the verdict binds to (§5/ADR 0058):
   ```bash
   HEAD_SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)"
   ```
2. **Materialize the head into a per-run ref (never the launched checkout)** — the §RO
   read-only path — and confirm it resolves to exactly that SHA before reviewing:
   ```bash
   PR_REF="refs/pr/$PR-$(uuidgen)"
   git fetch origin "pull/$PR/head:$PR_REF"
   FETCHED="$(git rev-parse "$PR_REF")"
   [ "$FETCHED" = "$HEAD_SHA" ] || { echo "FATAL: fetched head $FETCHED != resolved $HEAD_SHA — aborting" >&2; exit 1; }
   ```
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
review-code:   advisory — blocking-set PR (manual merge)
review-doc:    advisory — blocking-set PR (manual merge)
review-skill:  advisory — blocking-set PR (manual merge)
review-design: advisory — blocking-set PR (manual merge)
```

The rest of the body carries the same per-check evidence table the PASS/FAIL paths carry —
the verdict is *recorded* (for the human or delegated merge actor to read), it just **authorizes
nothing on its first line**. The advisory **first line** **carries no `@ <sha>`** on purpose: it
does not enter any `ship-it` `PASS @ <sha> — merge-ready` namespace, so a §CP PR is never
auto-mergeable off it (ADR 0053). A human merges it, **or** — under ADR 0135's approve-then-enqueue —
`ship-it` enqueues it once a `@kamp-us/control-plane` approval is present at head (ADR 0053/0065/0135).

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
caveat shape is the one being retired in favor of this; the reconciliation is part of #424's
build.)

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
review-design: advisory — blocking-set PR (manual merge)
```

so its verdict stays *out* of `ship-it`'s PASS namespace — a human merges those (ADR 0053).
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

`review-design` writes **exactly one** `review-design:` marker comment per PR: before posting
it scans for **its own** prior `review-design:` marker and `PATCH`es it with the fresh verdict
+ fresh `@ <sha>` rather than appending (ADR 0058 rule 2; same mechanism as §5/§6/§6.5).

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
  **non-blocking** UI PR **iff `<sha>` is the current head** — once `review-design`'s
  required-gate wiring lands as part of the ADR-0165 rollout (`ship-it` / `reviewer.md`
  consumption). `FAIL @ <sha> — changes-requested` (≥1 objective prohibition violated) is read
  by `write-code`'s fix round-trip as "my UI PR came back failed"; `ship-it` reads it as "do
  not merge."
- **Advisory for the blocking set.** A UI PR in the §CP set gets the **canonical advisory
  line** (§6.6), not a PASS marker — its verdict does not authorize that merge; a human does
  (ADR 0053/0065). Because a design verdict is calibrated to FAIL conservatively (a borderline
  call is downgraded to advisory), an advisory here can also mean "no objective prohibition
  hard-failed" — but on a §CP PR the first-line advisory is always the manual-merge shape.
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
```

- **Token source:** the claiming process's `CLAUDE_CODE_SESSION_ID` environment variable
  (the orchestrator's when it claims pre-spawn; the coder's when `write-code` is invoked
  directly — see §The pre-spawn claim protocol).
- **Write surface:** an issue comment, posted via `gh api repos/$REPO/issues/{N}/comments`
  (REST, never GraphQL): `gh api repos/$REPO/issues/<N>/comments -f "body=claim: $CLAUDE_CODE_SESSION_ID · $(date -u +%Y-%m-%dT%H:%M:%SZ)"`.
- **Read surface — the canonical `CLAIM_RE`.** A claim comment is matched by this **one**
  anchored, case-insensitive, emphasis-tolerant regex; every consumer cites it and **none
  re-hard-codes the grammar** (it pairs with §5/§6's marker-matcher discipline):

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
winner — fail-closed**, never a false win. The canonical resolution (read tolerantly per the
§Reading stance):

```bash
cf=$(mktemp); gh api "repos/$REPO/issues/<N>/comments?per_page=100" --paginate > "$cf"
CLAIM_RE='(?i)^\s*\**\s*claim:\s*[0-9a-f-]{36}\b'
# authors of any claim marker on the issue
claimAuthors=$(jq -r --arg re "$CLAIM_RE" '[.[] | select(.body | test($re)) | .user.login] | unique | .[]' "$cf")
# keep only write+ collaborators (the ADR 0055 trust root) — a forged claim is ignored, empty ⇒ no winner
authorized='[]'
while IFS= read -r a; do
  [ -z "$a" ] && continue
  perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
  case "$perm" in admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;; esac
done <<<"$claimAuthors"
# the EARLIEST authorized claim — min (created_at, comment id) — is the canonical winner; read its session.
WINSID=$(jq -r --argjson authorized "$authorized" '
  [.[] | select(.user.login | IN($authorized[]))
       | select(.body | test("(?i)^\\s*\\**\\s*claim:\\s*[0-9a-f-]{36}\\b"))
       | {sid: (.body | capture("(?i)^\\s*\\**\\s*claim:\\s*(?<s>[0-9a-f-]{36})").s), at: .created_at, id: .id}]
  | sort_by([.at, .id]) | first | .sid // ""' "$cf")
# you won iff the earliest authorized claim is yours
[ -n "$WINSID" ] && [ "$WINSID" = "$CLAUDE_CODE_SESSION_ID" ] && echo "claim is mine" || echo "not mine — back off"
```

This swaps the degenerate `lexicographic-min(login)` for `earliest(authorized claim)`,
resolved by the same **checkpoint GET against canonical issue state, fail-closed** shape the
old design used. The race-case derivation transfers and is *strengthened* (ADR 0115 §2):

- **Staggered co-racers.** Each posts a claim comment; the server stamps each a unique,
  monotonic `id`. The checkpoint GET re-reads the same canonical comment set, so exactly one
  finds the earliest authorized claim's session equals its own and proceeds; every other
  recomputes the same earliest claim, sees it is not theirs, **retracts its own claim
  comment** (`DELETE` the comment it posted), and re-picks. The comment-post detects, the GET
  resolves — same shape as the old assignee race, but the key is now agent-distinguishable.
- **Straggler / Rule-0 defer collapses into the tiebreak.** A late arrival's comment has a
  strictly larger `id`, so it is **never** the earliest authorized claim — it loses by
  construction, **and** Rule 0 (defer to a pre-existing owner — re-read before posting and
  back off if an authorized claim from a *different* session already owns it) tells it to
  back off before posting at all. Because **earliest-claim-wins, Rule 0 and the tiebreak are
  the same fact**: the pre-existing owner *is* the minimum. This removes the
  straggler-evicts-owner tension the old `min(login)` needed a separate non-revocability
  argument to close — a lower login could belong to a later arrival; a lower comment id
  cannot.
- **Transient window.** As before, the assignee field may transiently show two assignees and
  the comments two claims before a loser retracts; the picker skips on **any non-null
  assignee**, so a transiently double-claimed issue is passed over, never double-picked (safe
  degradation).

This remains **detect-and-tiebreak, not a kernel mutex** (the epic's honest non-goal): the
comment/assignee APIs offer no conditional write, so true single-writer exclusion is off the
table. The guarantee is the one that matters — of any set of co-window racers, exactly one
proceeds, deterministically, and every loser self-retracts its claim comment (and any
self-assignee) and re-picks. Don't reintroduce the "it's the lock" framing, and **never fall
back to the bare assignee login as an ownership signal** — that is the degeneracy ADR 0115
removes.

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
  claim-only agent that runs this §7 primitive verbatim): self-assign, post the claim
  comment, run the tiebreak, and **only on a win spawn the coder**, threading the winning
  claim **token** into the coder's prompt. On a lost claim it aborts the dispatch — no coder
  spawns.
- **Delegated ownership.** The orchestrator and the coder are distinct sessions (the spawned
  coder carries `CLAUDE_CODE_CHILD_SESSION=1` and its own id), so the claim token is
  **whoever posted the claim** — the orchestrator. The orchestrator threads its token to the
  coder; `write-code` Step 3 then **recognizes the existing claim as its delegated own** (the
  threaded token equals the earliest authorized claim's session) and proceeds **without
  posting a second, redundant claim** or re-racing.
- **Direct path (no orchestrator).** When `write-code` is invoked directly, its claim is
  made at **Step 3** using the coder's own `CLAUDE_CODE_SESSION_ID` as the token, before it
  branches or builds. Either way the claim precedes the work.

### Staleness / reclaim — owner-defer (ADR 0115 §5)

A claim whose agent crashed mid-run is **sticky until a human clears it** (un-assigns the
issue / removes the claim, re-opening it to the picker). Automatic TTL/hybrid reclaim is an
**explicitly deferred follow-up** — GitHub exposes no TTL primitive, and an automated
reclaim risks evicting a slow-but-live agent, re-introducing the exact double-implement this
design prevents. The marker's `<ISO-8601-UTC>` field (and server `created_at`) is the field
a future policy would key on, so the marker is forward-compatible without committing now.

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

The **zero-scope=fail invariant** (§ZS) is the one convention that is **not** a format but
a *behavioral contract every gate honors*: `review-code`/`review-doc`/`review-skill`,
`ship-it`, the epic-ledger validators (`review-plan`), and the CI cycle/convention checks
each cite §ZS rather than re-deriving emit-scope + fail-closed-on-zero-match. Its first
adoption is the epic-ledger floor — `validateLedger`'s `ZERO_SCOPE` defect fails a childless
epic closed, and the `review-plan` gate verdict emits the scanned child count — so the
convention ships demonstrated, not just stated (ADR 0092).
