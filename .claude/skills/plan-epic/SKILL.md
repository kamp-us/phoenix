---
name: plan-epic
description: Turn a triaged epic into an executable task ledger on kamp-us/phoenix — write a PRD-grade plan into the epic body, split it into native GitHub sub-issues, and pin a `## Dependencies` topology. Trigger on "plan the epic", "plan epic #N", "break down the epic", "/plan-epic", or whenever a `type:epic` `status:triaged` issue needs its plan and children. Re-runs reconcile an existing plan against a changed epic. Operates autonomously — no approval gate.
---

# plan-epic

You take a triaged epic (`type:epic` + `status:triaged`) and turn it into something
a fleet of `write-code` agents can execute without you in the loop: a plan written
into the epic body, a set of native GitHub sub-issues each carrying its own
acceptance criteria, and a pinned `## Dependencies` section that says what gates what.

You operate **autonomously**. The plan you write is read by `write-code` agents, not
presented to a human for sign-off — there is no propose-first, no approval gate. Plan,
split, link, done. (The human already approved the *epic* at triage; your job is to
make it executable, not to re-litigate whether it should exist.)

The epic body is **append-down**: the triaged original brief stays untouched at the
top, and you write *below* it. You never rewrite-on-top an epic — its original
content is the brief that grounds your plan, not noise to bury. (This is exactly the
exception triage carves out for epics; the formats doc spells out why.)

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
queries. Every read and write goes through `gh api`. Native sub-issues have a REST
surface (below); use it. This is not a style preference — GraphQL calls error out on
this org.

## The formats contract

You **write three of the four** shared formats; read them before you start:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).

- **`## Dependencies` grammar** (format 1) — the topology you pin at the bottom of
  the epic body: `### Phase N` headings as the sequential spine, the list within a
  phase as a parallel group, `requires: #N` as a cross-boundary gating edge.
  **Topology only** — no retry budgets, no concurrency caps, no code flags; those are
  orchestrator concerns, not shared issue state.
- **Sub-issue body** (format 2) — the shape of every child you create: optional
  `**Stories:**`, a `**TDD:**` flag, a `### What to build` prose spec, and a
  `### Acceptance criteria` checklist. The hard invariant: **every sub-issue body
  carries ≥ 1 acceptance criterion.** A child you can't state a single checkable
  criterion for is not yet specified — sharpen it or fold it into a sibling.
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
genuinely unanswerable without a human decision, carve it out as its own
`type:decision` child rather than blocking the whole plan on it.

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

Below the untouched brief, write the plan a `write-code` fleet needs. This is the
"product requirements" layer the brief only gestured at — concrete enough that each
child issue is a faithful slice of it. There's no rigid template; cover what the work
actually needs, but a solid plan usually has:

- **Goal / non-goals** — what this epic delivers, and the tempting-adjacent things
  it deliberately doesn't (the brief's out-of-scope, sharpened).
- **Resolved questions** — each open question from the brief, answered, with the
  one-line rationale grounded in the codebase. This is where the planning judgment
  shows.
- **Approach** — the shape of the solution: the modules/files involved, the data
  flow, the conventions it must honor (cite the ADR/pattern docs). Enough that the
  child issues don't each have to re-derive the architecture.
- **Task breakdown rationale** — *why* the work splits the way it does into the
  children below. The split should fall on natural seams (a write-code agent can
  finish one child in a PR or two), and the rationale is what makes the
  `## Dependencies` topology legible.

Keep it grounded. No invented requirements, no aspirational scope the brief didn't
ask for. The plan serves the children; if a paragraph doesn't change how a child gets
built, cut it.

---

## Step 3 — Split into sub-issues

Slice the plan into executable children. Each is **one task a `write-code` agent can
pick up cold** — finishable in a PR or two, with an unambiguous "done". Good seams:
one capability, one layer, one migration, one decision. Bad seams: "do half of
feature X" with no checkable boundary.

Each child's body follows the **sub-issue body format** (format 2) exactly:

```markdown
**Stories:** <story refs from the epic brief, if any — omit the line if none>
**TDD:** yes | no

### What to build
<One or two paragraphs of concrete scope: what changes, where, why. Name the
modules/files. State what's out of scope if there's a tempting adjacent thing.>

### Acceptance criteria
- [ ] <observable, externally checkable criterion>
- [ ] <…>
```

The invariants you must hold:

- **≥ 1 acceptance criterion per child.** Non-negotiable — `write-code` can't know
  when to stop and `review-code` can't verify without it. If you can't write one,
  the child isn't specified yet.
- **TDD flag honestly set.** `yes` for a behavior with a verifiable contract; `no`
  for config, docs, scaffolding, or an operational step. It's advice to write-code,
  not a gate.
- **Self-contained.** A child must not require reading sibling bodies to be
  understood — cross-task context flows through the epic's handoff notes and the
  `## Dependencies` graph, not by reference between child bodies.

Create each child via REST, assembling its body from a temp file so multi-line
markdown and backticks survive the shell:

```bash
BODY="$(cat /tmp/plan-epic-child.md)"
gh api repos/kamp-us/phoenix/issues \
  -f title="<sharp single-unit title>" \
  -f body="$BODY" \
  --jq '{number,id}'
```

Children inherit the epic's `type:*`? **No** — a child gets its own type from triage
semantics if it warrants one, but in practice plan-epic's children are pickable work
units: type them as the work is (`type:feature`, `type:chore`, etc.) and apply a
priority. Do **not** label children `status:needs-triage` — they were born from a
triaged plan, they're already actionable. Apply `status:triaged` plus a `type:*` and
a `p*` so `write-code` treats them as pickable:

```bash
gh api repos/kamp-us/phoenix/issues/<CHILD>/labels \
  -f "labels[]=type:feature" -f "labels[]=p2" -f "labels[]=status:triaged"
```

(Type and priority are your call as planner, the same authority triage has — you're
the one who understands the slice.)

---

## Step 4 — Link children as native sub-issues

GitHub has a **native sub-issues** relationship — link each child to the epic so it
shows up in the epic's `sub_issues_summary` and the GitHub UI's sub-issue list. This
is the real parent/child edge, not just a `## Dependencies` mention.

The endpoint takes the child's **database id** (`.id`), *not* its issue number:

```bash
# get the child's database id, then link it under the epic
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

## Step 5 — Write the `## Dependencies` topology into the epic body

Now pin the topology. Assemble the epic's new body as: **untouched brief** + **the
plan you wrote in Step 2** + **the `## Dependencies` section** referencing the child
numbers you just created.

The grammar (format 1): `### Phase N` headings are the sequential spine (every issue
in a phase closes before the next phase starts); the list within a phase is a
parallel group (no ordering between them); `requires: #N` on a child is a
cross-boundary gating edge for a dependency that doesn't fall on a phase boundary.
Topology only.

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
# /tmp/plan-epic-<EPIC>-body.md = brief (verbatim) + plan + ## Dependencies
BODY="$(cat /tmp/plan-epic-<EPIC>-body.md)"
gh api -X PATCH repos/kamp-us/phoenix/issues/<EPIC> -f body="$BODY"
```

**Keep the brief byte-for-byte.** Read the current top section out of
`/tmp/plan-epic-<EPIC>-current.md` (Step 1) and paste it back unchanged as the top of
the new body — don't reflow it, don't "tidy" it. Everything you add goes below it.

Sanity-check the result: the brief is still on top, the plan follows, and the
`## Dependencies` numbers match the children that exist and are linked.

---

## Re-plan: reconciling a changed epic

When you're re-run on an epic that already has a plan and children (the brief changed,
scope shifted, a child was closed), you **rewrite the plan and the task split
together** — but you don't blow away history. Judge **each existing child
individually**:

| Verdict | When | Action |
|---|---|---|
| **Keep** | The child is still a faithful slice of the new plan. | Leave it. If only its *framing* drifted, you may amend its body, but its identity stands. |
| **Amend** | The child's intent survives but its scope/criteria moved. | PATCH its body to the new spec (preserve its acceptance-criteria discipline). It stays linked, same number. |
| **Supersede** | The child no longer fits — the plan dropped it, merged it, or replaced it with a differently-shaped unit. | Close it with a **journal note** (below), unlink it, and create the replacement fresh if there is one. |

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

## Conventions

This skill is one of a suite (`report` → `triage` → **`plan-epic`** → `write-code` →
`review-code`) that turns GitHub issues into an agent-operable pipeline. The shared
label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). Your input is a
`type:epic` + `status:triaged` issue from `triage`; your output — the epic body's
plan + `## Dependencies`, and the linked sub-issues with their acceptance criteria —
is exactly what `write-code` reads to pick, sequence, and execute the work.
