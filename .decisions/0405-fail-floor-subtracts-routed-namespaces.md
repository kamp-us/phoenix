---
id: 0405
title: The reviewer's FAIL floor subtracts a routed namespace, as the PASS arm does
status: accepted
date: 2026-09-21
tags: [fabrika, lane, pipeline, review]
---

# 0405 — The reviewer's FAIL floor subtracts a routed namespace, as the PASS arm does

**What this decides:** a reviewer records a `FAIL` against the derived namespace set **minus** the
namespaces `review scope` prints as `routed`, the same subtraction ADR
[0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md) rules for the `PASS`
arm. Governance is never routed, so the governance obligation ADR
[0293](0293-governance-fires-every-round.md) rules is untouched: what this amends in 0293 is one
clause, its "`operate`'s all-namespaces-terminal floor on the `FAIL` row stays as written".

## Context

0293 kept the FAIL floor whole on purpose. It read the floor as the one thing that tells "the
reviewer declined" from "the reviewer died mid-emit", and it could keep the floor whole because
after that ruling nothing licensed a decline: governance is derived-required at every head, so a
missing governance verdict is always an unfinished read.

0320 then split the `PASS` bar across the two review cells. Out of the plain `review` cell a routed
namespace is the next cell's, and `lane prove` enforces that split mechanically. The FAIL polarity
was never carried over, and on this machine it cannot be met.

A routed `review-ui` is unfillable at a head where the text gate stands `FAIL`, by two different
routes and with no third:

- On a pull request that renders nothing, `review-ui route` is the sanctioned resolution and it
  refuses at exit `20` over a standing text `FAIL`
  ([`packages/fabrika-cli/src/review-ui/route-verb.ts`](../packages/fabrika-cli/src/review-ui/route-verb.ts),
  the `TEXT_REVIEW_UNMET` branch, which ADR
  [0329](0329-a-reviewers-park-is-proof-gated-by-the-fails-at-head.md)'s neighbourhood leaves
  standing and which this record does not touch).
- On a pull request that does render, `review-ui post` is the emit path and it reads no text verdict
  at all — `./text-verdict.ts` is imported by `route-verb.ts` and by nothing else — so the verdict is
  *permitted*. What keeps it from existing is the lane's own machine: the `review` cell's only arm
  into `review:ui` is `ISSUE.PASS` guarded on `class:ui`, and `ISSUE.FAIL` targets `build`
  ([`templates/coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json)).
  Nobody dispatches the gate that owes the row, so waiting for it is waiting on a spawn no state
  will make.

So the two rules were jointly unsatisfiable on every pull request whose diff raises a routed
`review-ui` and whose text gate fails. Lane 9594 / PR
[#9599](https://github.com/kamp-us/phoenix/pull/9599) hit it: the reviewer declined to record a real
`review-code` FAIL at `406407a3`, a `ui-reviewer` spawned to fill the namespace could produce
nothing, and the driver recorded the FAIL by hand
([#9603](https://github.com/kamp-us/phoenix/issues/9603)).

The mechanical half already agrees with the subtraction. `lane prove` answers `not-required` for a
`FAIL` out of `review`: `claimOf` in
[`packages/fabrika-cli/src/lane/prove.ts`](../packages/fabrika-cli/src/lane/prove.ts) gives a claim
only to `DONE` out of `build`, `PASS` out of the two review cells and `BLOCKED` out of them, so a
`FAIL` claims no artifact and is proven by nothing. Only the prose in `review` and `operate` blocked
the driver.

## Decision

**A reviewer's `FAIL` floor is the derived namespace set minus the `routed` rows, and `operate`'s
FAIL-row refusal asks for that same set.** Ruled on
[#9603](https://github.com/kamp-us/phoenix/issues/9603), engineering-led per ADR
[0078](0078-product-driven-decisions-by-default.md).

- The subtraction covers routed namespaces only. `governance` is never routed — `review`'s
  `routed elsewhere` terminal reaches `review-ui` and `check-epic-plan` alone — so 0293's ruling
  stands whole in substance: a `governance: required` FAIL round still owes its governance verdict
  at its head, and a missing one is still an unfinished read, never a licensed decline.
- 0293's clause that the floor "stays as written" is amended, and only for the routed arm. The
  distinction 0293 was protecting survives it: a namespace this gate is *permitted* to emit and did
  not is still an incomplete read the lane must not act on, and that is the whole population the
  floor was written to catch.
- `review-ui route`'s exit `20` precondition is untouched, and the merge bar is untouched:
  `ship gate` re-derives the whole set at the merge, so nothing here waives a namespace at the gate.
  0320's rejected direction stays rejected.

### Why a constant subtraction is right here and wrong on the PASS arm

0320 has a titled sub-section telling a reader not to re-propose hardcoding the subtraction, and the
FAIL arm takes exactly the shape it warns off: the reviewer subtracts every row `review scope`
printed as `routed`, with no read of whether this lane's machine routes anywhere that owes it. That
is deliberate, because the two harms 0320 names are harms of **walking to `ship` on a short set**:

- a machine with no `review:ui` arm (a `chore` workflow) deferring to a cell that does not exist,
  and
- a `ui` class nobody relayed, so the arm's guard does not hold and the lane takes the `ship` arm.

A `FAIL` reaches neither. It targets `build` on every template that has the event, the repair pushes
a new head, and the next round re-derives the whole namespace set there. No short set produced by
this subtraction can reach `ship gate`, which is the property 0320's derivation exists to protect.
The PASS arm keeps its machine-derived deferral unchanged, `lane prove` included.

This is the second exception on the same grounds, and it is drawn the same way. ADR
[0340](0340-an-epic-childs-review-ui-is-the-tails-by-construction.md) already made an epic child's
deferral unconditional, on the reading that 0320's two reasons are both about a lane that owns a
pull request. Here they are both about an event that walks to `ship`. Neither exception widens the
other: outside these two cases the deferral is still read off the machine.

## Consequences

- A reviewer records a `FAIL` at a head whose only unfilled namespace is a routed one, and the lane
  enters repair without a driver recording the verdict by hand.
- `operate`'s FAIL-row refusal reads as a floor that is always reachable on every polarity, which is
  what 0293 wanted of it and what a routed `review-ui` denied it.
- The FAIL half stays prose in `review` and `operate`. `lane prove` is unchanged: it answers
  `not-required` for this event, so there is no mechanical floor here to keep in step.
- A reviewer that dies mid-emit over a routed namespace is now indistinguishable from one that
  correctly left it to the next cell. That loss is accepted for the routed rows alone, and it costs
  nothing the machine can spend: a `FAIL` routes into repair under the retry budget either way, and
  the merge gate re-derives the namespace before anything ships.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/9603
- Amends in part: ADR [0293](0293-governance-fires-every-round.md)
- Extends to the FAIL polarity: ADR
  [0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md)
- The deadlock observed live: lane 9594, PR https://github.com/kamp-us/phoenix/pull/9599
- no vocabulary impact
