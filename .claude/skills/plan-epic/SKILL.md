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
# capture the body AND its revision marker from ONE GET — reading them in two calls lets a writer
# land between them, yielding an updated_at newer than the captured body (TOCTOU skew); the Step 5
# recheck would then either spuriously retry or trust a marker that doesn't match the captured body.
gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '{body,updated_at}' > /tmp/plan-epic-<EPIC>-snap.json
jq -r '.body'       /tmp/plan-epic-<EPIC>-snap.json > /tmp/plan-epic-<EPIC>-current.md
jq -r '.updated_at' /tmp/plan-epic-<EPIC>-snap.json > /tmp/plan-epic-<EPIC>-updated-at.txt
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

### The write is a guarded read-modify-write, never a blind overwrite

The epic body is **load-bearing shared state** — its `## Dependencies` topology is what
`write-code` reads to decide what's pickable. A second `plan-epic` run, or a `review-plan`
child-flip, or a re-plan loop, can edit the same body concurrently; a blind whole-body
`PATCH` would silently clobber that edit (the lost-update this step exists to prevent — issue
#261, same last-write-wins family as the issue-claim race
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 (issue #260) and the
SHA-bound verdict contract, ADR [0058](../../../.decisions/0058-sha-bound-verdict-contract.md)
(issue #258)). GitHub's issue `PATCH` honors **no** `If-Match`/`If-Unmodified-Since` — there is no
native compare-and-swap — so the write is made safe by **two layers**, in order:

**Layer 1 — surgical section replacement (collision avoidance).** Don't reassemble the body
from your in-memory plan and overwrite the whole thing. Re-read the epic's **current** body
immediately before the write, replace **only the section you changed** (the `## Dependencies`
block, and — when re-planning — the `## Plan (plan-epic)` block), and leave every other byte of
the live body exactly as you just read it. A concurrent edit to a *different* part of the body
(the brief, a sibling's handoff note, a label-driven addition) then cannot collide with your
write at all — you preserved it verbatim because you never reconstructed it.

**Layer 2 — optimistic recheck (abort+retry on a same-section race).** Two writers editing the
*same* section still race. So immediately before the `PATCH`, re-GET the epic's `updated_at` and
compare it to the marker captured in Step 1. If it **moved**, another writer touched the body
since you read it: **abort, re-read the body from scratch, re-derive your section against the
fresh revision, and retry** — never `PATCH` over a body you didn't just read.

The re-derive is the part that makes this honest, and it is **your action, not the script's**.
The block below is a **skeleton you re-run per attempt, not a one-shot you launch once**: a
`## Dependencies` block names concrete child numbers and phase topology, so when the recheck
fires (a racer added/closed a child between your reads) you must **regenerate
`/tmp/plan-epic-<EPIC>-deps.md` — and on a re-plan `/tmp/plan-epic-<EPIC>-plan.md` — against the
freshly-read body** (re-run Step 2's split + Step 5's section derivation) *before* you re-enter
the loop. The script cannot do this for you inside one bash invocation; it can only **refuse to
proceed** until you have. So the recheck branch stamps the fresh base and **breaks out** (it does
not silently `continue` onto a stale `deps.md`), and a guard at the top of each attempt **aborts
loudly** if `deps.md` was not regenerated since the base it splices onto was read — turning the
"re-derive" from a comment you might skip into a precondition the script enforces.

```bash
# /tmp/plan-epic-<EPIC>-deps.md = the new `## Dependencies` block. On a RE-PLAN, also
#   /tmp/plan-epic-<EPIC>-plan.md = the new `## Plan (plan-epic)` block (set REPLAN=1).
#   Give each block a trailing blank line so the next spliced heading stays separated.
# Landing is confirmed against the WHOLE `## Dependencies` block round-tripping byte-for-byte,
# NOT a single line: two concurrent runs on the SAME epic likely both emit a given `- #<child>`
# line (they share children), so a lone matching line can't tell our section from a racer's
# clobber (see step 6). deps.md is re-derived by YOU between attempts (the recheck breaks out and
# hands back; step 2) — the freshness guard (step 2.5) enforces it was, so each pass splices a block
# derived against the body it's splicing onto, never a stale one.
# A first-time plan has NO `## Dependencies` heading yet (Step 2 doesn't write one) — that case
# APPENDS the block to EOF; a re-plan has exactly one and SPLICES it in place. Zero headings on a
# re-plan, or more than one ever, is corruption: abort loudly (step 4).
#
# This block is a SKELETON you re-run per attempt, not a one-shot. When the recheck (step 2) fires
# it stamps the fresh base, BREAKS, and hands back to you to re-derive `deps.md` (+ `plan.md` on a
# re-plan) against `/tmp/plan-epic-<EPIC>-current.md` — then you re-invoke the block. The freshness
# guard (step 2.5) refuses to splice a `deps.md` older than the base it would splice onto, so a
# stale block can never re-clobber a racer's legitimate topology.
# Per attempt: re-read → recheck (verify unchanged) → freshness guard → anchor guard → splice/append → PATCH
# → re-verify our block landed. `landed=1` only after a pass confirms the round-trip; `patched=1`
# records that a PATCH was actually issued (so the terminal verdict can tell "raced every time,
# never wrote" from "wrote and lost"). The terminal check after the loop turns an
# exhausted-or-aborted run into a hard STOP rather than ambiguous output.
landed=0; patched=0
for attempt in 1 2 3; do
  # 1. re-read the LIVE body + its revision marker from ONE GET (coherent — no TOCTOU skew)
  gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '{body,updated_at}' > /tmp/plan-epic-<EPIC>-live.json
  jq -r '.body'       /tmp/plan-epic-<EPIC>-live.json > /tmp/plan-epic-<EPIC>-live.md
  NOW=$(jq -r '.updated_at' /tmp/plan-epic-<EPIC>-live.json)
  WAS=$(cat /tmp/plan-epic-<EPIC>-updated-at.txt)

  # 2. optimistic recheck — if the body moved since we last read it, stamp the fresh base and BREAK.
  #    Re-deriving the section is YOUR action (the script can't regenerate deps.md/plan.md inside one
  #    bash invocation): re-run Step 2's split + Step 5's derivation against the now-fresh
  #    `-current.md`, then re-invoke this block. The freshness guard (2.5) enforces that you did.
  if [ "$NOW" != "$WAS" ]; then
    echo "epic body changed since read ($WAS -> $NOW) — RE-DERIVE deps.md (+ plan.md on a re-plan)"
    echo "  against the fresh base, then re-invoke this block. (Not auto-retried: the re-derive is an agent step.)"
    cp /tmp/plan-epic-<EPIC>-live.md /tmp/plan-epic-<EPIC>-current.md   # fresh base to re-derive against
    echo "$NOW" > /tmp/plan-epic-<EPIC>-updated-at.txt
    break
  fi

  # 2.5. freshness guard — `deps.md` (and, on a re-plan, `plan.md`) MUST have been (re-)derived
  #      against the base this attempt is splicing onto. That base is `-current.md` (stamped from the
  #      live body the recheck above just confirmed unchanged), and your re-derive writes deps.md
  #      AFTER it — so deps.md must be newer than current.md (`-nt` = "newer than"). If it isn't, the
  #      re-derive precondition is unmet (you re-invoked without regenerating the block off the fresh
  #      base): a stale block that references the wrong child set. Abort loudly, don't write — this is
  #      what stops the `continue`-era footgun of re-splicing the originally-derived block (issue #261).
  if ! [ /tmp/plan-epic-<EPIC>-deps.md -nt /tmp/plan-epic-<EPIC>-current.md ] \
     || { [ "${REPLAN:-0}" = 1 ] && ! [ /tmp/plan-epic-<EPIC>-plan.md -nt /tmp/plan-epic-<EPIC>-current.md ]; }; then
    echo "ABORT: deps.md (or plan.md on a re-plan) is NOT newer than the base it splices onto (-current.md) —"
    echo "       you re-invoked without re-deriving. Re-run Step 2's split + Step 5's section derivation"
    echo "       against /tmp/plan-epic-<EPIC>-current.md, then re-invoke this block. Refusing to splice a stale block."
    break
  fi

  # 3. anchor guard — the splice keys off the count of exact `## Dependencies` headings:
  #      0 + first-time plan → no topology pinned yet (Step 2 omits it): APPEND to EOF (step 4a).
  #      1                   → re-plan with an existing section: SPLICE it in place (step 4b).
  #      0 + re-plan, or >1  → corruption (heading drifted to `## Dependencies (phased)`, was
  #                            deleted, or duplicated): a blind splice/append would orphan or
  #                            double the section. Abort loudly, leave `landed=0`.
  DEPS_HEADINGS=$(grep -c '^## Dependencies[[:space:]]*$' /tmp/plan-epic-<EPIC>-live.md)
  if [ "$DEPS_HEADINGS" -gt 1 ] || { [ "$DEPS_HEADINGS" -eq 0 ] && [ "${REPLAN:-0}" = 1 ]; }; then
    echo "ABORT: live body has $DEPS_HEADINGS exact '## Dependencies' headings (want 0 on a first-time plan, 1 on a re-plan) — refusing to splice; inspect by hand"
    break
  fi

  # 3b. on a re-plan, the Plan splice (step 4) keys off `## Plan (plan-epic)` the same way deps keys
  #     off `## Dependencies` — and the same drift bites: 0 means the heading drifted (e.g. `## Plan`)
  #     and the awk would splice NOTHING (the re-planned plan silently dropped); >1 means it'd double.
  #     Want exactly 1 on a re-plan. (First-time plans don't splice the plan block, so skip the check.)
  if [ "${REPLAN:-0}" = 1 ]; then
    PLAN_HEADINGS=$(grep -c '^## Plan (plan-epic)[[:space:]]*$' /tmp/plan-epic-<EPIC>-live.md)
    if [ "$PLAN_HEADINGS" -ne 1 ]; then
      echo "ABORT: re-plan but live body has $PLAN_HEADINGS exact '## Plan (plan-epic)' headings (want exactly 1) — refusing to splice; inspect by hand"
      break
    fi
  fi

  # 4. surgical splice/append: write ONLY the changed section(s), keep every other byte verbatim.
  if [ "$DEPS_HEADINGS" -eq 0 ]; then
    # 4a. FIRST-TIME plan — no `## Dependencies` heading exists. Append the block to the END of a
    #     byte-for-byte copy of the live body (the brief + plan above are preserved untouched).
    cp /tmp/plan-epic-<EPIC>-live.md /tmp/plan-epic-<EPIC>-body.md
    cat /tmp/plan-epic-<EPIC>-deps.md >> /tmp/plan-epic-<EPIC>-body.md
  else
    # 4b. RE-PLAN — `## Dependencies` is the pinned LAST section: cut from its heading to EOF,
    #     append fresh deps. (DEPS_HEADINGS == 1 here.)
    awk '/^## Dependencies[[:space:]]*$/{exit} {print}' /tmp/plan-epic-<EPIC>-live.md \
      > /tmp/plan-epic-<EPIC>-body.md
    cat /tmp/plan-epic-<EPIC>-deps.md >> /tmp/plan-epic-<EPIC>-body.md
  fi
  # On a RE-PLAN, `## Plan (plan-epic)` ALSO changed — splice it in place too: delete the inclusive
  # `## Plan (plan-epic)`..next-`## ` range and re-insert the fresh plan block at that boundary.
  if [ "${REPLAN:-0}" = 1 ]; then
    awk -v plan="/tmp/plan-epic-<EPIC>-plan.md" '
      /^## Plan \(plan-epic\)[[:space:]]*$/ { while ((getline l < plan) > 0) print l; skip=1; next }
      skip && /^## / { skip=0 }
      !skip { print }
    ' /tmp/plan-epic-<EPIC>-body.md > /tmp/plan-epic-<EPIC>-body.2.md \
      && mv /tmp/plan-epic-<EPIC>-body.2.md /tmp/plan-epic-<EPIC>-body.md
  fi
  BODY="$(cat /tmp/plan-epic-<EPIC>-body.md)"

  # 5. extract THIS run's whole `## Dependencies` block (heading → EOF) from the body we're about
  #    to write — that exact multi-line block is what we'll confirm round-tripped, so a racer who
  #    happens to share a child number can't satisfy the check with one matching `- #` line.
  awk '/^## Dependencies[[:space:]]*$/{f=1} f{print}' /tmp/plan-epic-<EPIC>-body.md \
    > /tmp/plan-epic-<EPIC>-deps-expected.md

  # 6. write, then re-confirm OUR WHOLE BLOCK landed — extract `## Dependencies`→EOF from the live
  #    post-write body and diff it against the block we just wrote. A racer's clobber differs
  #    somewhere in the block (different topology/labels/ordering), so an exact block match — not a
  #    heading or a single child line — is what tells our section from theirs. The residual window
  #    (below) means the PATCH is still last-write-wins; this is the honest after-the-fact check
  #    that retries the loser.
  gh api -X PATCH repos/kamp-us/phoenix/issues/<EPIC> -f body="$BODY" >/dev/null; patched=1
  gh api repos/kamp-us/phoenix/issues/<EPIC> --jq '.body' \
    | awk '/^## Dependencies[[:space:]]*$/{f=1} f{print}' > /tmp/plan-epic-<EPIC>-deps-live.md
  if diff -q /tmp/plan-epic-<EPIC>-deps-expected.md /tmp/plan-epic-<EPIC>-deps-live.md >/dev/null; then
    echo "epic body updated, our whole ## Dependencies block round-tripped"; landed=1; break
  else
    # A racer clobbered our write. Do NOT auto-re-splice the stale deps.md — that would
    # silently re-clobber the racer's legitimate same-section topology change. Mirror the
    # recheck-break (step 2): snapshot the racer's body as the FRESH base, then break to hand
    # back to the agent to RE-DERIVE deps.md (and plan.md on a re-plan) against it before any
    # re-splice. The freshness guard (step 2.5) then enforces the re-derive on the next invoke,
    # so a stale block can never re-clobber.
    echo "our ## Dependencies block is NOT the one in the post-write body — a racer clobbered it."
    echo "       Re-derive deps.md (and plan.md on a re-plan) against the refreshed"
    echo "       /tmp/plan-epic-<EPIC>-current.md, then re-invoke this block. Refusing to re-splice the stale block."
    gh api repos/kamp-us/phoenix/issues/<EPIC> > /tmp/plan-epic-<EPIC>-snap.json   # one snapshot, no TOCTOU between body+updated_at
    jq -r '.body'       /tmp/plan-epic-<EPIC>-snap.json > /tmp/plan-epic-<EPIC>-current.md      # fresh base to re-derive against
    jq -r '.updated_at' /tmp/plan-epic-<EPIC>-snap.json > /tmp/plan-epic-<EPIC>-updated-at.txt
    break
  fi
done

# Terminal verdict — the loop can exit several ways; only one is success. An orchestrator (and the
# next agent reading the transcript) must not mistake an exhausted-or-aborted run for a win. The two
# non-success modes differ: a run that NEVER issued a PATCH (raced + re-derived, or a guard aborted)
# left the body untouched; a run that DID PATCH but lost the round-trip left it possibly half-written.
if [ "$landed" != 1 ]; then
  echo "plan-epic: could NOT land the ## Dependencies block — STOP and inspect, do not proceed."
  if [ "$patched" = 1 ]; then
    echo "  (A PATCH was issued but our block didn't round-trip — a racer clobbered it. The epic body"
    echo "   may be half-written with someone else's topology; the topology this run derived is NOT pinned.)"
  else
    echo "  (No PATCH was ever issued — either a guard aborted (corrupt/duplicated heading, or deps.md"
    echo "   not re-derived against the fresh base), or every attempt raced and handed back to re-derive."
    echo "   The epic body is untouched; the topology this run derived is NOT pinned.)"
  fi
fi
```

**Keep the brief byte-for-byte.** With the surgical splice/append this is automatic: a first-time
plan appends the `## Dependencies` block to a verbatim copy of the live body; a re-plan copies the
live body up to the `## Dependencies` heading verbatim and re-appends the fresh block. Either way
the brief above the plan is untouched bytes from the live read; on a re-plan the `## Plan
(plan-epic)` block is itself re-spliced in place (step 4), and everything outside the two changed
sections is verbatim — don't reflow the brief, don't "tidy" it, don't reconstruct it from memory —
splice around it.

**Honest residual — this narrows the window, it is not a lock.** The recheck (layer 2) only
*detects* a race that completed before this run's read; a writer who edits **after** your
`updated_at` read but **before** your `PATCH` lands is still lost-update territory, because the
`PATCH` itself is last-write-wins (GitHub offers no conditional write on issue bodies). Layer 1
shrinks the blast radius to *same-section* collisions; layer 2 narrows the same-section window;
the re-confirm in step 6 — diffing the whole `## Dependencies` block that round-tripped, not the
section heading or a single child line two racers might share — catches the loser *after the fact*
so it retries rather than failing silently, and the terminal verdict turns an exhausted-or-aborted
run into a hard STOP rather than a silent half-write. What this is
**not** is mutual exclusion — true single-writer safety on one epic would
need a designated single planner or a CAS the API doesn't provide (same honest framing as the
issue-claim semantics in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 and
the SHA-bound verdict contract, ADR 0058). Don't claim a "lock"; claim "no silent lost-update of
the topology," which is what the acceptance asks for.

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
top, as always. The re-plan write goes through **the same guarded read-modify-write as
Step 5** — surgical section splice + optimistic `updated_at` recheck, never a blind
whole-body `PATCH`. Re-plan is exactly the concurrency hot-spot the guard exists for: a
re-plan loop racing a fresh `plan-epic` run or a `review-plan` child-flip is the
lost-update case in issue #261. Write the fresh `## Plan (plan-epic)` block to
`/tmp/plan-epic-<EPIC>-plan.md`, the fresh `## Dependencies` block to
`/tmp/plan-epic-<EPIC>-deps.md`, and run the Step 5 loop with `REPLAN=1` so it splices
**both** sections into the freshly-read live body in place (the live body already has exactly one
`## Dependencies` heading and exactly one `## Plan (plan-epic)` heading to splice against — the
loop's anchor guards abort if either drifted). When `updated_at` moved since your read, the loop
breaks and hands back so you **re-derive both blocks against the fresh base** before re-invoking it
— the re-derive is your step, not the script's, and the freshness guard enforces you did it. (On a
first-time plan, leave `REPLAN` unset — the live body has no `## Dependencies` heading yet, so the
loop appends the new block to EOF instead of splicing, and the Plan-heading guard is skipped.)

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
