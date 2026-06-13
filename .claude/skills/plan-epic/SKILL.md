---
name: plan-epic
description: Turn a triaged epic into an executable, PRD-grade task ledger on kamp-us/phoenix — a plan whose product layer (problem, user stories, testing strategy) leads and engineering layer follows, split into tracer-bullet sub-issues that each trace to a user story, with a pinned `## Dependencies` topology. Trigger on "plan the epic", "plan epic #N", "break down the epic", "/plan-epic", or whenever a `type:epic` `status:triaged` issue needs its plan and children. Autonomous — no interview or approval gate; re-runs reconcile.
---

# plan-epic

You take a triaged epic (`type:epic` + `status:triaged`) and turn it into something
a fleet of `write-code` agents can execute without you in the loop: a **PRD-grade plan**
written into the epic body, a set of native GitHub sub-issues each carrying its own user-story
trace and acceptance criteria, and a pinned `## Dependencies` section that says what gates what.

"PRD-grade" is the bar this skill exists to hold. A plan that lists only architecture and a
task split is half a plan — it says *how* without ever saying *who needs this and what changes
for them*. Your plan **leads with the product layer** (the problem, the solution from the user's
view, the user stories, the testing strategy) and **then** lays down the engineering layer
(approach, split rationale). The user stories are the spine: they are what you slice the
children from, and every child traces back to one. See ADR
[0046](../../../.decisions/0046-plan-epic-prd-grade-plans.md) for why.

You operate **autonomously**. The plan you write is read by `write-code` agents, not presented
to a human for sign-off — there is **no interview, no propose-first, no approval gate**. You
author the product layer from the brief + the existing product + codebase exploration + your own
product judgment; you do not ask the user questions (the human already approved the *epic* at
triage). When a user story hinges on a genuine product decision you can't ground from the
codebase, carve it as a `type:decision` child — never handwave it. Plan, split, link, done.

The epic body is **append-down**: the triaged original brief stays untouched at the top, and you
write *below* it. You never rewrite-on-top an epic — its original content is the brief that
grounds your plan, not noise to bury. (This is exactly the exception triage carves out for
epics; the formats doc spells out why.)

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
queries. Every read and write goes through `gh api`. Native sub-issues have a REST
surface (below); use it. This is not a style preference — GraphQL calls error out on
this org.

## The formats contract

You **write three of the five** shared formats; read them before you start:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).

- **`## Dependencies` grammar** (format 1) — the topology you pin at the bottom of
  the epic body: `### Phase N` headings as the sequential spine, the list within a
  phase as a parallel group, `requires: #N` as a cross-boundary gating edge.
  **Topology only** — no retry budgets, no concurrency caps, no code flags; those are
  orchestrator concerns, not shared issue state. (The orchestrator itself is not this repo's
  job — ADR [0046](../../../.decisions/0046-plan-epic-prd-grade-plans.md); the topology is the
  only dependency artifact phoenix keeps.)
- **Sub-issue body** (format 2) — the shape of every child you create: a **required**
  `**Stories:**` line (the story numbers from your plan this child implements or unblocks), a
  `**TDD:**` flag, a `### What to build` prose spec, and a `### Acceptance criteria` checklist.
  Two hard invariants: **every child carries ≥ 1 acceptance criterion**, and **every child
  traces to ≥ 1 user story** (see the coverage invariant in Step 3).
- **Epic handoff note** (format 4) — you don't *post* these (that's `write-code` as
  children complete), but your plan should make the cross-task signal they'll carry
  predictable. The `## Dependencies` graph is the spine those handoffs route along.

Read the formats doc tolerantly when reconciling an existing plan (re-plan, below) and
write it canonically. Tolerant reading is the safety margin, not the target.

---

## Step 1 — Read the epic and gather context

Read the epic body — the **brief** is the top section, the part above any plan you may
have written on a prior run. Then read enough of the codebase to plan against what's
actually there: the files and modules the brief names, the ADRs in `.decisions/`, the
patterns in `.patterns/`, related issues and PRs. A plan written without the codebase
is a wish list; a plan written from it is executable.

Resolve the brief's open questions **yourself** from the codebase and project
conventions — that is the planning work. The epic brief often ends with open
questions (triage leaves them for you). Answer them in the plan with a stated
rationale; don't punt them downstream as unscoped ambiguity. If a question is
genuinely a product or architecture fork that needs human-judgment — not something the
codebase settles — carve it as its own `type:decision` child rather than blocking the
whole plan on it. (This is the autonomous substitute for the interview a human-facing PRD
tool would run: you resolve what you can and turn the rest into decision work, you don't
stop to ask.)

> In the bash below, `<EPIC>` / `<CHILD>` angle-bracket tokens are placeholders you
> hand-substitute with concrete issue numbers; `$VARS` (e.g. `$CHILD_ID`, `$BODY`)
> are live shell variables the commands set and read.

```bash
# the epic, its current body, its labels, and any children it already has
gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '{number,title,labels:[.labels[].name],sub_issues_summary}'
gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '.body' > /tmp/plan-epic-<EPIC>-current.md
gh api 'repos/kamp-us/phoenix/issues/<EPIC>/sub_issues?per_page=100' \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

If the epic already has sub-issues or a plan section, you're **re-planning** — jump to
[Re-plan](#re-plan-reconciling-a-changed-epic) after you've drafted the new plan, and
reconcile rather than blindly recreate.

---

## Step 2 — Write the PRD-grade plan

Below the untouched brief, write the plan a `write-code` fleet needs, as a
`## Plan (plan-epic)` section whose subsections lead with the **product layer** and then the
**engineering layer**. Write these exact `###` headings, in this order, under
`## Plan (plan-epic)`:

```markdown
## Plan (plan-epic)

### Problem & who has it
### What changes
### User stories
### Goal / non-goals
### Resolved questions
### Approach
### Testing strategy
### Task-split rationale
```

(The `## Dependencies` topology is a separate top-level section you pin in Step 5 — not part
of this plan block.) What each section holds:

**Product layer — lead with this.**

- **Problem & who has it** — the problem from the user's perspective: who is affected
  (include automated agents — kamp.us is a human-*and*-agent surface), and why it matters
  now. Grounded in the brief + the existing product, not invented. This is the section
  whose absence makes a plan read as "just architecture."
- **What changes** — the solution from the user's perspective: what is different once this
  ships, stated as the experience, not the implementation.
- **User stories** — the spine of the plan, written under the stable `### User stories`
  heading so every child's `**Stories:**` line can reference them by number. A numbered list,
  each: *As a `<actor>`, I want `<capability>`, so that `<benefit>`.* Be **extensive** — cover
  the happy path, edge cases, error states, and admin/moderation flows; thin generic stories
  produce thin tasks. Each story should be specific enough to demo. Actors include agents
  where the surface is agent-facing. **These stories are what you slice the children from in
  Step 3, and every child traces back to one** — so write them first and write them well.
  A story that depends on an unresolved product decision becomes a `type:decision` child (Step
  1); don't bury the fork inside a vague story.

**Engineering layer — then this.**

- **Goal / non-goals** — what this epic delivers, and the tempting-adjacent things it
  deliberately doesn't (the brief's out-of-scope, sharpened).
- **Resolved questions** — each open question from the brief, answered, with the one-line
  rationale grounded in the codebase. This is where the planning judgment shows. Genuine
  human-judgment forks are carved as `type:decision` children instead of answered here.
- **Approach** — the shape of the solution: the modules/layers involved, the data flow, the
  conventions it must honor (cite the ADR/pattern docs). Enough that the child issues don't
  each re-derive the architecture. **No specific file paths or code snippets** — name modules
  and layers, not `path/to/file.ts:42`; paths and snippets go stale fast and the children read
  the live code anyway.
- **Testing strategy** — which behaviors/modules get tested and why, and at which tier (cite
  ADR [0040](../../../.decisions/0040-testing-taxonomy-and-seam-graduation.md)'s T0–T3
  taxonomy and `.patterns/effect-testing.md`); what makes a good test here (behavior, not
  implementation); prior art in the repo to follow. This is what sets each child's `**TDD:**`
  flag honestly, instead of guessing per child.
- **Task-split rationale** — *why* the work splits the way it does into the children below.
  The split is tracer-bullet vertical (Step 3) and falls on natural seams; the rationale is
  what makes the `## Dependencies` topology legible, and it names which stories each slice
  carries.

Keep it grounded. No invented requirements, no aspirational scope the brief didn't ask for.
The plan serves the children; if a paragraph doesn't change how a child gets built or what it
delivers to a user, cut it.

---

## Step 3 — Split into sub-issues (tracer-bullet, story-covered)

Slice the plan into executable children. Each implementation child is a **tracer-bullet
vertical slice**: a thin path through *every layer it touches* (storage → service → fate →
UI → tests) that delivers one narrow-but-complete piece of user-visible value, demoable on
its own. Prefer **many thin slices over few thick ones**. A child a `write-code` agent can
pick up cold and finish in a PR or two, with an unambiguous "done".

`type:decision` and `type:investigation` children are the exception to "vertical slice" —
they produce a *record* (an ADR via `/adr`, or a diagnosis), not a layered code change. They
still trace to the stories or forks they unblock.

### The story-coverage invariant (enforced)

This is the discipline that makes the split PRD-derived rather than invented:

- **Every user story is covered by ≥ 1 child.** A story with no child implementing it is an
  unfinished plan — add the child or fold the story.
- **Every child traces to ≥ 1 story** via its `**Stories:**` line — the stories it implements,
  or (for decision/investigation/infra children) the stories it *unblocks*. A child that traces
  to no story is scope creep — cut it. The rare genuinely-pure-infra child that unblocks no
  single story carries the explicit marker `**Stories:** none (pure infra — see What to build)`
  and justifies itself in `### What to build`; the line is never silently left blank.

Before you finish, run the coverage check both directions: list each story → the child(ren)
covering it, and each child → its story(ies). An uncovered story or an untraceable child means
the split isn't done.

Each child's body follows the **sub-issue body format** (format 2) exactly:

```markdown
**Stories:** <REQUIRED — story numbers this child implements or unblocks; or `none (pure infra — see What to build)`>
**TDD:** yes | no

### What to build
<One or two paragraphs of concrete scope: what changes, where, why. Name the
modules/files. State what's out of scope if there's a tempting adjacent thing.>

### Acceptance criteria
- [ ] <observable, externally checkable criterion>
- [ ] <…>
```

(A child's `### What to build` *may* name concrete files — it sits close to the code. Only the
epic-level **Approach** (Step 2) stays path-free, because it ages faster and the children read
the live code anyway.)

The invariants you must hold:

- **≥ 1 user story per child.** The `**Stories:**` line is required and never blank — it names
  the stories the child implements or unblocks (or, for the rare pure-infra child, the explicit
  `none (pure infra — see What to build)` marker). See the coverage invariant above.
- **≥ 1 acceptance criterion per child.** Non-negotiable — `write-code` can't know
  when to stop and `review-code` can't verify without it. If you can't write one,
  the child isn't specified yet.
- **TDD flag honestly set** from the testing strategy (Step 2). `yes` for a behavior with a
  verifiable contract; `no` for config, docs, scaffolding, or an operational step. It's
  advice to write-code, not a gate.
- **Self-contained.** A child must not require reading sibling bodies to be understood —
  cross-task context flows through the epic's handoff notes and the `## Dependencies` graph,
  not by reference between child bodies. (The story numbers point into the epic plan's
  `### User stories`, which is shared context, not a sibling body.)

Create each child via REST, assembling its body from a temp file so multi-line
markdown and backticks survive the shell:

```bash
BODY="$(cat /tmp/plan-epic-child.md)"
gh api repos/kamp-us/phoenix/issues \
  -f title="<sharp single-unit title>" \
  -f body="$BODY" \
  --jq '{number,id}'
```

Capture both `number` and `id` from the create — Step 4 links by the `id`, so you won't need
to re-fetch it.

Children get their own type from the work they are (`type:feature`, `type:chore`,
`type:bug`, `type:decision`, `type:investigation`) — **not** inherited from the epic — plus a
priority. Do **not** label children `status:needs-triage`: they were born from a triaged plan,
they don't re-enter triage. But they are **not yet pickable either** — they're born
**`status:planned`**, the pre-gate state. `write-code` keys on `status:triaged`, so a
`status:planned` child stays unpickable until the `review-plan` gate validates the ledger and
flips `planned → status:triaged` (per ADR
[0047](../../../.decisions/0047-review-plan-gate.md) — that flip *is* the whole enforcement
mechanism: an unverified-but-pickable child is unrepresentable). Apply `status:planned` + a
`type:*` + a `p*`:

```bash
gh api repos/kamp-us/phoenix/issues/<CHILD>/labels \
  -f "labels[]=type:feature" -f "labels[]=p2" -f "labels[]=status:planned"
```

`POST .../labels` is **additive** — it appends to whatever the child already carries,
it doesn't replace the set (relevant if you re-apply labels to an existing child during
an amend).

(Type and priority are your call as planner, the same authority triage has — you're
the one who understands the slice.)

---

## Step 4 — Link children as native sub-issues

GitHub has a **native sub-issues** relationship — link each child to the epic so it
shows up in the epic's `sub_issues_summary` and the GitHub UI's sub-issue list. This
is the real parent/child edge, not just a `## Dependencies` mention.

The endpoint takes the child's **database id** (`.id`), *not* its issue number:

```bash
# the child's database id (reuse the .id from the Step 3 create if you captured it)
CHILD_ID=$(gh api repos/kamp-us/phoenix/issues/<CHILD> --jq '.id')
gh api -X POST repos/kamp-us/phoenix/issues/<EPIC>/sub_issues \
  -F sub_issue_id=$CHILD_ID \
  --jq '.sub_issues_summary'
```

`-F` (not `-f`) so the id is sent as a number. Confirm the link landed:

```bash
gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '.sub_issues_summary'
# total should equal the number of children you linked
gh api 'repos/kamp-us/phoenix/issues/<EPIC>/sub_issues?per_page=100' \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

The exact-equality check holds on the fresh-plan path, where every linked child is
still open. On the **re-plan path** — once you've closed superseded children — don't
rely on it: `sub_issues_summary.total` is known to **undercount** when children are a
mix of open and closed (a GitHub sub-issues caveat). There, the
`GET .../sub_issues` list above is the source of truth for what's actually linked.

To **unlink** a child (you'll need this in re-plan when a child is superseded), the
endpoint is **singular** `sub_issue` (not `sub_issues`), and the id goes in the JSON
body via `--input` — `-X DELETE … -F` does **not** work here:

```bash
echo "{\"sub_issue_id\": $CHILD_ID}" \
  | gh api -X DELETE repos/kamp-us/phoenix/issues/<EPIC>/sub_issue --input -
```

Unlinking does not close the child; it just removes the parent/child edge. Closing is
a separate state change (the journal-note path in re-plan).

---

## Step 5 — Write the body (brief + plan + `## Dependencies`)

Now assemble and pin the full body: **untouched brief** + **the PRD-grade plan from Step 2**
+ **the `## Dependencies` section** referencing the child numbers you just created.

The dependency grammar (format 1): `### Phase N` headings are the sequential spine (every
issue in a phase closes before the next phase starts); the list within a phase is a parallel
group (no ordering between them); `requires: #N` on a child is a cross-boundary gating edge
for a dependency that doesn't fall on a phase boundary. **Topology only** — no retry budgets,
concurrency caps, or code flags (those are the out-of-repo orchestrator's, per ADR 0046).

Derive the topology from the task-split rationale: independent slices share a phase (parallel);
a slice that needs another's output sits in a later phase, or carries a `requires:` for a
single specific predecessor.

```markdown
## Dependencies

### Phase 1
- #<a> — <label>
- #<b> — <label>

### Phase 2
- #<c> — <label> (requires: #<a>)
- #<d> — <label>
```

Assemble and PATCH from a temp file so the whole multi-section body survives intact:

```bash
# /tmp/plan-epic-<EPIC>-body.md = brief (verbatim) + PRD-grade plan + ## Dependencies
BODY="$(cat /tmp/plan-epic-<EPIC>-body.md)"
gh api -X PATCH repos/kamp-us/phoenix/issues/<EPIC> -f body="$BODY"
```

**Keep the brief byte-for-byte.** Read the current top section out of
`/tmp/plan-epic-<EPIC>-current.md` (Step 1) and paste it back unchanged as the top of
the new body — don't reflow it, don't "tidy" it. Everything you add goes below it.

Sanity-check the result: the brief is still on top, the plan follows (product layer first),
the `### User stories` section is present, the `## Dependencies` numbers match the children that
exist and are linked, and every story maps to a child (the coverage invariant).

---

## Re-plan: reconciling a changed epic

When you're re-run on an epic that already has a plan and children (the brief changed,
scope shifted, a child was closed), you **rewrite the plan and the task split
together** — but you don't blow away history. Re-derive the user stories first (they may have
grown or shifted), then judge **each existing child individually** against the new story set:

| Verdict | When | Action |
|---|---|---|
| **Keep** | The child is still a faithful slice of the new plan and still covers its story. | Leave it. If only its *framing* drifted, you may amend its body, but its identity stands. |
| **Amend** | The child's intent survives but its scope/criteria/stories moved. | PATCH its body to the new spec (preserve its acceptance-criteria + `**Stories:**` discipline). It stays linked, same number. |
| **Supersede** | The child no longer fits — the plan dropped it, merged it, or replaced it with a differently-shaped unit. | Close it with a **journal note** (below), unlink it, and create the replacement fresh if there is one. |
| **Frozen** | The child is already `closed` (its work merged). | Leave it untouched — it's history; the new plan builds on it. Never reopen or supersede a closed-done child. |

After reconciling, re-run the **story-coverage check** (Step 3) against the new story set:
a newly-added story with no child needs one; an orphaned child needs a story or a cut.

**Closed-done children are history — never reopen or supersede them.** A child that's
already `closed` because its work merged is part of the record. The new plan builds on
top of it; it doesn't pretend the work didn't happen. Only **open** children are
candidates for amend/supersede.

### The journal note (superseding a child)

Every supersede is auditable. Before closing a superseded child, post a comment saying
*why* and where the work went, so the trail is legible:

```bash
gh api repos/kamp-us/phoenix/issues/<CHILD>/comments \
  -f body="Superseded by re-plan of #<EPIC>: <specific reason — e.g. 'scope merged into #<NEW>' or 'dropped, the brief no longer asks for X'>."
# unlink from the epic (singular sub_issue, id in the JSON body), then close not-planned
CHILD_ID=$(gh api repos/kamp-us/phoenix/issues/<CHILD> --jq '.id')
echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE repos/kamp-us/phoenix/issues/<EPIC>/sub_issue --input -
gh api -X PATCH repos/kamp-us/phoenix/issues/<CHILD> -f state=closed -f state_reason=not_planned
```

### Fall back to full-supersede when reconciliation is messy

Per-child judgment is the default because it preserves the most history. But when the
plan changed so much that mapping old children to new ones is a tangle — you can't
cleanly say which old child maps to which new one — **don't force a bad mapping.**
Full-supersede instead: close every *open* child with a journal note pointing at the
new plan, then create the new split clean. Closed-done children stay as history
untouched. A clean new split with honest journal notes beats a contorted
keep/amend mapping that leaves children half-describing the old plan and half the new.

After reconciling children, rewrite the plan body and the `## Dependencies` section
(Steps 2 and 5) to match the surviving + new children. The brief stays untouched on
top, as always.

---

## Cleaning up after a dry-run

When validating against a **scratch epic** (a throwaway you created to test the skill,
not a real backlog epic), tear it down afterwards so the real backlog stays clean.
Closing isn't enough — the children and the epic should be removed. You can't delete
issues via the public REST API, so the honest cleanup is: unlink and close every
scratch child not-planned, close the scratch epic, and label them so they're
unmistakably test debris.

```bash
# for each scratch child: unlink + close
CHILD_ID=$(gh api repos/kamp-us/phoenix/issues/<CHILD> --jq '.id')
echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE repos/kamp-us/phoenix/issues/<EPIC>/sub_issue --input -
gh api -X PATCH repos/kamp-us/phoenix/issues/<CHILD> -f state=closed -f state_reason=not_planned
# then close the scratch epic
gh api -X PATCH repos/kamp-us/phoenix/issues/<EPIC> -f state=closed -f state_reason=not_planned
```

(If you have repo-admin and the GraphQL `deleteIssue` mutation is available to you,
deleting outright is cleaner — but GraphQL is unreliable on this org, so closing is
the dependable path.) Never run dry-run validation against a real epic; spin up a
scratch one.

---

## Running it

A single invocation takes one epic from triaged brief to executable ledger: read the epic +
codebase (Step 1), write the PRD-grade plan — product layer (problem / solution / **user
stories** / testing strategy) then engineering layer (Step 2), split into tracer-bullet
children that each trace to a story (Step 3), link them as native sub-issues (Step 4), and pin
the full body with its `## Dependencies` topology (Step 5). Re-runs reconcile.

Report back a short ledger: the epic, the story count, the children created (with the story
each covers), and the phase topology. Don't narrate every REST call — the epic body and the
linked sub-issues are the durable record.

## Conventions

This skill is one of a suite (`report` → `triage` → **`plan-epic`** → `review-plan` →
`write-code` → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency/story formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md); the decision to make
plan-epic's output PRD-grade, story-driven, coverage-enforced, and autonomous (with the
personal PRD/orchestrator harness deliberately kept out of the repo) is ADR
[0046](../../../.decisions/0046-plan-epic-prd-grade-plans.md). Your input is a
`type:epic` + `status:triaged` issue from `triage`; your output — the epic body's PRD-grade
plan + `## Dependencies`, and the linked sub-issues with their story traces and acceptance
criteria — is what `write-code` reads to pick, sequence, and execute the work, once the
`review-plan` gate has flipped each child `status:planned → status:triaged` (ADR
[0047](../../../.decisions/0047-review-plan-gate.md)).
