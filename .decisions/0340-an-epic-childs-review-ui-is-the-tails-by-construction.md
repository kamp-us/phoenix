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
