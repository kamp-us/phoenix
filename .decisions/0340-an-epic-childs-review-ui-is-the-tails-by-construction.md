---
id: 0340
title: An epic child's review-ui is the tail's by construction, not by routing
status: accepted
date: 2026-08-29
tags: [fabrika, lane, pipeline, review, epic, state-machine]
---

# 0340 — An epic child's review-ui is the tail's by construction, not by routing

**What this decides:** a `PASS` out of an epic child's `review` cell defers the routed namespaces
unconditionally. `lane prove` does not ask the machine which arm that event takes, because on a
child there is no arm that could change the answer. This is the one exception to ADR
[0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md)'s rule that the
deferral is derived from the machine and never from a constant, and it is an exception because 0320's
two reasons for that rule are both about a lane that owns a PR.

## Context

0320 split the review bar across `review` and `review:ui` for a single-issue lane, and made the
subtraction conditional on the machine taking the `review → review:ui` arm. It named hardcoding as
the shape to refuse, with two failure modes: a machine with no such arm defers to a cell that does
not exist, and a class nobody relayed drops a namespace the merge gate will still demand.

Neither reaches an epic child, and requiring `review-ui` of one was unwalkable:

- A child's region is `queued → build → review → integrate → landed` and carries no `review:ui` cell
  at all ([`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts)), so
  the arm 0320 keys on can never be taken.
- Every verb that may post a `review-ui` verdict resolves live PR state
  ([`packages/fabrika-cli/src/review-ui/`](../packages/fabrika-cli/src/review-ui/)), and an epic
  child opens no PR by design (ADR [0285](0285-epic-machine-ends-in-review.md)). `review post` is
  fenced out of the namespace on both its head and range paths
  ([`packages/fabrika-cli/src/review/classes.ts`](../packages/fabrika-cli/src/review/classes.ts)'s
  `ROUTED_NAMESPACES`).

So a ui-bearing child derived a namespace no cell of its machine and no verb of this CLI could ever
fill, and sat at exit `23` forever. Epic #6767's tracer C ([#7031](https://github.com/kamp-us/phoenix/issues/7031))
hit it, was parked, drew a founder ruling authorizing the deferral, and still had no cell that could
execute even that — the funnel shipped by hand-integration
([#7041](https://github.com/kamp-us/phoenix/issues/7041)). Same deadlock class as
[#7035](https://github.com/kamp-us/phoenix/issues/7035): two gates each correct alone, jointly
unwalkable.

## Decision

A child's `PASS` out of `review` defers `ROUTED_NAMESPACES` whatever `nextLeaf` answers. The
namespace is not waived — it moves to the epic's tail, and it moves there by construction rather
than by bookkeeping:

**One epic run is one branch and one PR** (ADR 0285). Every rendered file a child's range added is
in the tail PR's own diff, so the tail's `partitionWithUi` derives `review-ui` from the same paths
the child's range did. The tail's `review` cell routes to `ship` and to no ui cell, so under 0320's
own rule its `PASS` defers nothing and stands on the whole set — at a head where a preview exists,
which is the one place the rendered gate can run. `ship gate` re-derives all of it at the merge as
before.

Nothing needed adding to carry the debt: the tail already required what the child now hands it. What
the fix added is the disclosure, below.

### Why not key the child's deferral on the `ui` class instead

That would put the child back inside 0320's letter at the cost of its spirit. The class arrives on
`lane report --class ui`, relayed by a reviewer; on a single lane a forgotten flag is caught because
the lane then owes the namespace at `review` and refuses there. On a child there is no cell that
could ever fill it, so a forgotten flag would not restore a floor — it would restore the deadlock,
and a relayed flag would be the only thing standing between a child and a wall. A gate whose
walkability depends on a shell remembering a flag is not a gate.

### Why not give a child a `review:ui` cell

Because a cell it entered could produce nothing: the rendered gate needs a preview, and a preview
needs a deployed head, which needs the PR ADR 0285 rules a child does not open. Emitting the cell
would move the same wall one state to the right.

### The deferral is disclosed on the event line

`lane prove`'s answer carries what it actually subtracted — the claim's candidate set intersected
with what the range derives — and `lane report` records it as `deferred` on the appended event,
which `parseLog` reads back so `lane history` prints it. Without it a deferred `PASS` and a
whole-set one are the same line, and nothing in the ledger says a rendered verdict is still owed
anywhere. The field is absent wherever nothing was deferred, so a child that renders nothing writes
the line it always wrote.

## Consequences

- A ui-classed epic child records `PASS` out of `review` with no `review-ui` verdict at child scope,
  and its epic keeps walking.
- A `review-ui` record posted at child scope — verdict or `routed-elsewhere` — is read by nothing.
  The namespace is not this cell's, exactly as a deferred namespace is not read on the PR arm.
- A child whose range raises no `ui` class is byte-for-byte unchanged: it derives no `review-ui`, so
  the subtraction removes nothing, its stderr gains no line, and its event line gains no field.
- The epic still cannot ship on an unjudged rendered surface. The tail owes `review-ui` on the whole
  set, and `ship gate` owes it again at the merge.
- 0320's rule stands for every lane that owns a PR. This narrows it to that population and says why
  the other one cannot be derived: on a child the answer is not a routing fact, it is a fact about
  what a child *is*.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/7041
- Instance: epic #6767's tracer C, https://github.com/kamp-us/phoenix/issues/7031
- Narrows: ADR [0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md)
- Rests on: ADR [0285](0285-epic-machine-ends-in-review.md), ADR [0317](0317-ui-lane-carries-its-own-shells.md)

## Amendment — 2026-09-16: the creditor gets a cell, so the tail defers like any PR-owning lane

This record's decision is untouched: a child's `PASS` out of `review` still defers
`ROUTED_NAMESPACES` unconditionally, and the creditor is still the epic's tail. What changes is one
sentence of the reasoning above, which described the tail as it then stood rather than as it had to
stand.

"The tail's `review` cell routes to `ship` and to no ui cell, so under 0320's own rule its `PASS`
defers nothing and stands on the whole set" was true of
[`emit.ts`](../packages/fabrika-cli/src/lane/emit.ts) and false of what the tail could actually
walk. A tail standing on the whole set has nowhere to *produce* it: `review` routes to `ship`, so no
cell of the generated machine dispatches the rendered gate, and
[`lane-brief.ts`](../packages/fabrika-cli/src/wire/lane-brief.ts) maps `ui-reviewer` to a state the
document never held. Every epic whose diff classed `ui` refused its tail `PASS` at exit `23` forever,
and could not park honestly either — `review` is an active state, so `lane recover`'s stale sweep
never saw it. Live instance: epic lane 8716, PR [#8750](https://github.com/kamp-us/phoenix/pull/8750)
— `governance`, `review-code` and `review-doc` all PASS at `fca9f763`, CI green, tail refused with
~20 files classed `ui`. Its driver got out by hand-composing a ui-reviewer spawn off the tail's own
`review` brief with the `shell:` line swapped, which `operate` otherwise forbids.
[#8937](https://github.com/kamp-us/phoenix/issues/8937) is the repair.

**The generated tail region now carries `review:ui`**, entered by the `class:ui` arm on its `review`
`PASS` and shaped like the committed
[coder template](../packages/fabrika-cli/src/lane/templates/coder.workflow.json)'s: `PASS` to `ship`,
`BLOCKED` to `blocked`, a budget-guarded `FAIL` falling through to `human:budget-spent`, and the
machinery `LAP` self-loop when `machineryLaps.onEmit` is set. So the tail now defers exactly the way
0320 rules a PR-owning lane must — derived from its own machine, never from a constant — and this
record's one exception stays the child's alone. No child region gains the cell; the section above
saying why still holds word for word.

Two shapes this amendment deliberately does **not** build:

- **No `build:ui` at the tail.** A tail repair round is briefed on the assembly branch beside the
  run's one PR, and `lane-brief.ts` admits that pair for `build` alone; a rendered repair is the
  mixed builder's per-file law over that same branch. A `build:ui` at the tail would need that
  refusal widened for one cell that dispatches nothing a `build` brief cannot.
- **No class seed on the tail's context.** The tail is emitted before any child has classed
  anything, so the class can only arrive as the `classes` a reviewer relays on `lane report --class
  ui`. That is the same relay 0320 already requires of a single lane, and it fails the same way: an
  unrelayed class leaves the whole set owed at `review` and refuses there. Unlike a child, the tail
  has a cell that can pay, so a forgotten flag is a refusal to fix rather than a wall.

A lane already emitted does not adopt the cell — the machine is fixed at emission, exactly as
0285's own amendment says of the tail's `build`.

Sources: [#8937](https://github.com/kamp-us/phoenix/issues/8937), epic lane 8716 /
PR [#8750](https://github.com/kamp-us/phoenix/pull/8750),
[`emit.ts`](../packages/fabrika-cli/src/lane/emit.ts),
[`prove.ts`](../packages/fabrika-cli/src/lane/prove.ts)'s `REVIEW_UI_STATE`.
