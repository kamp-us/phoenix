---
id: 0451
title: A lane parked at cp-approval re-enters review when its head is refreshed
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, lane, machine]
---

# 0451 — A lane parked at cp-approval re-enters review when its head is refreshed

**What this decides:** The lane machine gains a transition out of `human:cp-approval` into `review`,
so a pull request whose head moved while it waited for an approval gets a recorded review round at
the new head before any approval binds to it.

## Context

A lane that passed review parks at `human:cp-approval` until a control-plane owner approves. While
it waits the pull request can fall behind its base. Refreshing the head can turn every verdict
`current: false` ([ADR 0276](0276-verdict-binds-content-not-only-head.md)), so the head owes a fresh
review round. The machine had no cell for that round. The park walked `UNBLOCKED`, which resumes
`ship`, and a `FAIL` into `build` for a red head. `lane brief` refuses a park, so no reviewer could
be dispatched through the lane.

[#6380](https://github.com/kamp-us/phoenix/issues/6380) records three occurrences. Each time the
driver ran the reviewer outside the lane machine, and the ledger missed a review round that really
happened. On one of them the re-review failed, and the `FAIL` had no cell to land in, so the ledger
said "awaiting approval" over a head whose review gate was red.

The issue named two shapes:

1. A new transition out of `human:cp-approval` that re-enters `review` at the new head and returns
   to the same park on `PASS`.
2. Treat the refresh as an `UNBLOCKED` followed by a re-entry. This costs a human write on every
   drift and reuses `UNBLOCKED`, which today means an owner approved.

The founder ruled on 2026-08-20, recorded at
[#6380, comment 5363110295](https://github.com/kamp-us/phoenix/issues/6380#issuecomment-5363110295):

> #6380 PR going stale at cp-approval: Yes — add the transition (agent-ready work)

This ADR transcribes that ruling ([ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md)).

## Decision

**The machine carries a transition out of `human:cp-approval` into `review`, in the coder template
and in the emitted epic tail. A refreshed head is not handled as an `UNBLOCKED` re-entry.**

The ruling picks shape 1. Two things it leaves where they were, both stated on the issue beside it:

- The approval still binds. The re-review returns to the park only by the path that reached it the
  first time: `review`, then `ship`, then the shipper's `BLOCKED`. The new transition reaches neither
  `ship` nor `shipped`, and nothing clears the park on the machine's own account.
- The operator's event vocabulary stays closed
  ([ADR 0297](0297-frozen-is-a-park-not-an-end.md)). This decision adds no event name.

The transition is built on `WIP`, an event the operator already records. It is a plain target: a
re-review is neither a repair round nor a queue wait, so it spends no budget. That spelling is how
the ruling was built, and the ruling itself names no event.

The operator records it when the gate verdicts at the pull request's live head read
`current: false` in `fabrika build verdicts --pr <n>`. The `operate` skill carries that step.

## Consequences

A re-review at a refreshed head is on the ledger: the reviewer is dispatched through `lane brief`,
and its `PASS` or `FAIL` has a cell. A `FAIL` there is an ordinary repair round out of `review`.

`human:cp-approval` stays a park. It still routes to no shell, and `UNBLOCKED` is still the only way
through it to `ship`.

A coder lane booted before this transition holds no such cell and refuses the `WIP` until
`lane migrate` brings its machine up to the template. An emitted epic machine is never migrated, so
an epic lane emitted earlier keeps the hand route the `operate` skill describes.

The condition for recording the `WIP` is a step the operator follows, and no verb proves it. A lane
that leaves the park through `UNBLOCKED` before the round is run lands in `ship`, which has no
transition back to `review` for a stale head. The ruling names the park only, so that second cell is
not decided here.

## Records

no vocabulary impact
