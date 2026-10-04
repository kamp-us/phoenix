---
id: 0458
title: A lane in `review:ui` re-enters `review` when a sibling verdict goes stale, and base drift still stales a verdict
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, lane, machine, review]
---

# 0458 — A lane in `review:ui` re-enters `review` when a sibling verdict goes stale, and base drift still stales a verdict

**What this decides:** The coder machine's `review:ui` cell gains a transition into `review`, so a
lane whose text verdict went stale while it waited there gets a recorded review round. The rule
that made the verdict stale is kept as it is.

## Context

A lane reaches `review:ui` by passing `review` with the `ui` class raised. Its `PASS` out of
`review:ui` owes every derived namespace, `review-code` included. If the branch takes a merge from
main that reaches a path the pull request also changed, the `review-code` verdict stops binding
([ADR 0276](0276-verdict-binds-content-not-only-head.md)). `lane report --token PASS` then refuses
at exit `23`, which is correct.

The cell has no transition into `review`, so nothing the lane may record gets the text verdict
written again. At `origin/main` the cell in
[`coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json) walks
`PASS`, `BLOCKED`, `LAP`, `FAIL` and `WIP`:

- `PASS` is refused by the stale verdict.
- `FAIL` records a verdict the ui reviewer did not give, sends the lane to `build:ui`, and spends a
  repair round.
- `LAP` returns to `review:ui`, where the same refusal waits.
- `BLOCKED` and `WIP` leave the review phase without running a reviewer.

[#7734](https://github.com/kamp-us/phoenix/issues/7734) records one occurrence (lane 7045) and
[#9954](https://github.com/kamp-us/phoenix/issues/9954) a second (lane 9862). Each time the driver
ran a text reviewer outside the lane machine. `lane brief` prints the ui reviewer's brief for this
state, and the `operate` skill forbids a hand-composed spawn.

The issue named three shapes:

1. A transition out of `review:ui` into `review`, so the machine owns the route.
2. `lane brief` learns to brief the shell that a named stale namespace owes, and the machine stays
   as it is.
3. Reopen ADR 0276's base-drift rule so a merge from main does not stale a text verdict.

The ruling is recorded at
[#7734, comment 5625054879](https://github.com/kamp-us/phoenix/issues/7734#issuecomment-5625054879),
dated 2026-09-10. A driver session wrote it on the founder's behalf. It names as its authority the
founder's standing ruling on [#8807](https://github.com/kamp-us/phoenix/issues/8807) that engine
calls are the driver's to decide:

> **Ruled:** add the arm that re-derives the stale sibling namespace, keep ADR 0276's base-drift
> rule closed

This ADR transcribes that ruling ([ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md)).

## Decision

**The coder machine's `review:ui` cell carries a transition into `review` for a lane whose sibling
verdict went stale, and ADR 0276's base-drift rule is not reopened.**

The ruling picks shape 1 and rejects shape 3 in so many words. It gives a reason for neither
rejection. The reasons below are the record's reading of the corpus, and the ruling does not state
them.

**Shape 2 is rejected.** A text reviewer briefed while the lane sits in `review:ui` would have no
cell for its answer. A `FAIL` from it would fold through the `review:ui` cell into `build:ui`, the
wrong builder. The transition puts the round in `review`, where a `PASS` and a `FAIL` both already
have cells.

**Shape 3 is rejected.** ADR 0276 keeps "invalidate on base drift that reaches a reviewed path" on
purpose: once the base changes a file the pull request touches, `base + diff` is a combination no
reviewer read. The verdict on lane 7045 carried a content digest and went stale under that rule as
designed. ADR 0276 stands whole, and its dropped leg (base drift that reaches no reviewed path)
stays dropped.

### What a `review:ui` `PASS` owes

The whole derived set. This is a reading of
[ADR 0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md), not an amendment:
0320 says "out of `review:ui` the whole derived set stands", and
[ADR 0396](0396-head-diff-decides-a-review-rounds-classes.md) repeats it. The other reading on the
issue, that the `PASS` owes only `review-ui` and leaves the rest to `ship gate`, is not taken. It
would move the refusal to the merge gate and cost a wasted ship dispatch and a park, which is the
outcome 0320 was written to remove.

The transition is what makes this reading workable. The `PASS` keeps its full bar, and the lane now
has a recorded way to meet it.

### The event vocabulary stays closed

The ruling names no event and widens nothing. `OPERATOR_EVENTS` in
[`machine.ts`](../packages/fabrika-cli/src/lane/machine.ts) stays at seven. The issue says six
because it was written before [ADR 0377](0377-machinery-lap-narrows-repair-budget.md) added `LAP`.
The closure itself is [ADR 0297](0297-frozen-is-a-park-not-an-end.md)'s.

So the transition is spelled on an event already in the set. Which event and which guard is the
build's to spell, inside these bounds:

- Not `FAIL`. No reviewer failed the head, and a `FAIL` spends a repair round (ADR 0377).
- Not `PASS`. `lane prove` refuses it while the sibling verdict is stale.
- The machine has one existing spelling that sends a round to another stage, the `lap:<cause>`
  route on `LAP`. The driver ruling at
  [#9149, comment 5687471381](https://github.com/kamp-us/phoenix/issues/9149#issuecomment-5687471381)
  states the rule for admitting a routed cause. Whether a stale sibling verdict meets that rule is
  not ruled here.

If no existing event fits, the build stops and the spelling goes back for a ruling. It does not add
an eighth event on this record's authority.

**Binding constraints.**

- A lane in `review:ui` with a stale sibling verdict reaches `review` through a transition the
  machine declares, never through a hand-dispatched reviewer.
- A `PASS` out of `review:ui` proves the whole derived set.
- `OPERATOR_EVENTS` holds seven. Widening it needs its own ruling.
- A verdict still dies on base drift that reaches a reviewed path.

## Consequences

The text re-review is on the ledger. The reviewer is dispatched through `lane brief` from `review`,
and its `PASS` or `FAIL` lands in that cell. A `FAIL` there is an ordinary repair round.

After a `PASS` with the `ui` class the lane returns to `review:ui` by the transition that took it
there the first time. Whether the ui reviewer runs again when its own verdict still binds is not
decided here.

The ruling names the coder cell. The emitted epic tail carries a `review:ui` cell of its own
([ADR 0340](0340-an-epic-childs-review-ui-is-the-tails-by-construction.md)), and whether it gets the
same transition is not decided here.

A lane booted before the transition lands holds no such cell until `lane migrate` brings its machine
up to the template.

The build is tracked at [#10452](https://github.com/kamp-us/phoenix/issues/10452). The same gap at
the `ship` cell is [#10417](https://github.com/kamp-us/phoenix/issues/10417), and at the approval
park it was closed by [ADR 0451](0451-parked-lane-rereviews-refreshed-head.md).

## Records

no vocabulary impact
