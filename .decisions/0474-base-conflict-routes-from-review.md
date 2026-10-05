---
id: 0474
title: A base conflict seen in review sends the lane to a builder on a machinery lap, never a repair round
status: accepted
date: 2026-10-05
tags: [fabrika, lane, pipeline, state-machine, review]
---

# 0474 — A base conflict seen in review sends the lane to a builder on a machinery lap, never a repair round

**What this decides:** when a PR starts to conflict with its base while its lane waits in `review`
or `review:ui`, the lane goes to a builder that merges the base in. That trip spends a machinery lap,
not one of the ticket's repair rounds.

## Context

`base-conflicted` was already a routed lap cause, but only out of `ship`, where `ship enqueue` reads
the conflict at exit `21`. `ROUTED_MACHINERY_CAUSES` in
[`lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts) admitted it there and nowhere else.
The two review cells' laps looped back on themselves.

So a PR that went stale against `main` while it waited for a reviewer had no way to a builder. CI
does not run on a conflicted head, so the reviewer could not grade it and ended `UNKNOWN`. The only
ways out were a fake `FAIL`, which spends a repair round on a machinery fault, or a driver merging
`main` by hand. [#9954](https://github.com/kamp-us/phoenix/issues/9954) records it on lanes 9862,
10088 and 10032, and on a public adopter's lane.

The driver rule at
[#9149, comment 5687471381](https://github.com/kamp-us/phoenix/issues/9149#issuecomment-5687471381)
admits a routed cause "only when its remedy is re-running the same stage on a moved base or a healed
machine, never a change to the head". Clearing a conflict changes the head, so the rule alone did not
settle the review cells.

The founder ruled on the rulings desk on 2026-10-04, at
[#9954, comment 5983100185](https://github.com/kamp-us/phoenix/issues/9954#issuecomment-5983100185):

> A PR that starts to conflict with main while it waits in review has no engine route to a builder
> (#9954). May a base conflict send the lane from review back to a builder, spending a retry lap and
> not a repair round?

He picked "Yes, allow the route". This record transcribes that ruling
([ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md)).

## Decision

**`base-conflicted` routes out of `review` and `review:ui` to a builder, spending a machinery lap.**

- **Where it goes.** In the single-issue coder machine, `review`'s lap leads with
  `lap:base-conflicted` into `build`, and `review:ui`'s into `build:ui`. A mixed lane in `review:ui`
  lands in `build:ui` too: the round is a merge of the base, not a repair of the rendered surface.
  An emitted epic tail has one construction cell, so both of its review cells route this lap to
  `build`. Every other lap cause out of either review cell still loops the cell it came from.
- **Why the #9149 rule does not block it.** The ruling settles this; what follows is this record's
  reading of why the two agree. The rule keeps a cause from crossing stages when its
  remedy is a head change. That limit is about who may change the head, and a builder is the one
  stage that may. `ship`'s route already sends this same cause to a builder, so admitting it from
  the review cells extends one routing to the other two cells that can see the conflict.
- **What it spends.** One lap, counted against `MACHINERY_LAP_BUDGET`, as
  [ADR 0377](0377-machinery-lap-narrows-repair-budget.md) rules for every machinery failure. No
  reviewer judged the head, so no repair round is owed. When the laps run out the lane parks on
  `human:machinery-stall`.
- **Who records it.** The driver, on an observed read: before it briefs a reviewer in either cell it
  reads `build verdicts --pr <n>`, and a `mergeability` of `conflicting` records `BASE-CONFLICTED`.
  An `unknown` read is not a conflict and records nothing. The `operate` skill carries the step.
- **Who clears it.** The builder the lap lands on merges the PR's base into its branch and resolves
  the conflict in that round. It never rebases, because a rebase rewrites commits the PR already
  published. The `build` skill carries the step.
- **Old lanes.** A lane copies its `workflow.json` at `lane open`, so one booted before this route
  holds review cells with no `lap:base-conflicted` arm. `lane report` refuses the lap there at exit
  `12` with the log untouched, the fail-closed answer `ROUTED_MACHINERY_CAUSES` already gives.
  `lane migrate` brings a single-issue lane onto the route.

**Binding constraints.**

- A base conflict seen in a review cell spends a lap, never a repair round.
- The lap is recorded only on a definite `conflicting` read, never on `unknown` or a prediction.
- A builder clears the conflict by merging the base in, never by rebasing published commits.
- A lap cause other than `base-conflicted` and `text-review-stale` still self-targets in the review
  cells.

## Consequences

A PR that goes stale in review reaches a builder without a person, and without spending the
ticket's repair rounds. The re-review that follows the merge is an ordinary review round.

A lane that parked `blocked` over a conflict before this landed still needs its `UNBLOCKED`. The
driver's pre-brief read then routes it.

The clean-but-behind case from the 2026-10-03 comment on #9954 (lane 8776: a PR that merges clean
but whose preview predates a platform fix) is not a conflict. This record does not route it.

## Records

no vocabulary impact
