---
id: 0421
title: A spent repair budget's route is the one park route a repo may declare
status: accepted
date: 2026-09-27
tags: [fabrika, lane, pipeline, recipes, config]
---

# 0421 — A spent repair budget's route is the one park route a repo may declare

**What this decides:** a repo's `.fabrika.jsonc` may say whether a spent repair budget is its
driver's park or a person's. Every other park cause keeps the route its cause table row declares.

## Context

ADR [0376](0376-driver-seat-for-non-product-parks.md) put a route on every park cause and bound it
there: *"A route is declared once, on the cause. A verb that decides whose park it is by reading
anything else is deriving a decision it should be relaying."* ADR
[0378](0378-driver-seat-on-a-spent-repair-budget.md) gave the spent-budget cause,
`repair-budget-spent`, the route `driver`, and ADR
[0393](0393-lane-clear-grants-both-repair-budgets.md) let the driver's `lane clear` grant both of a
lane's repair budgets.

Those records are phoenix's corpus, and `operate` pointed at them as the authority for a driver's
self-grant. An adopting repo has no such record. Its driver either grants rounds on an authority its
repo never recorded, or parks every spent budget on a person
([#9827](https://github.com/kamp-us/phoenix/issues/9827)). Epic
[#9843](https://github.com/kamp-us/phoenix/issues/9843) moves rules like this out of phoenix's own
records and into fabrika, and its plan names this one: *"Who clears a spent repair budget becomes a
config setting that operate cites, instead of a phoenix decision record."* That plan carries a
control-plane approval
([#9843, comment 5852634112](https://github.com/kamp-us/phoenix/issues/9843#issuecomment-5852634112)),
and #9827's acceptance criteria fix the shape: two values, `driver` and `founder`, shipped `driver`.

The child shipped that setting as `parkCause.repairBudgetSpent`, and `recipe unpark` reads it.
The governance review of the epic's tail
([#9921](https://github.com/kamp-us/phoenix/pull/9921)) found that this reads a route off something
other than the cause, against 0376's binding constraint, and that no record said so. This record
transcribes the approved plan. It makes no new choice.

## Decision

**`parkCause.repairBudgetSpent` declares the route of the `repair-budget-spent` cause, and no other
cause's route can be declared.**

- **The cause table still holds the route, as the shipped value.** The `repair-budget-spent` row in
  [`lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts) keeps `route: "driver"`, and the
  setting ships `driver`. A repo that declares nothing routes a spent budget exactly as 0378 ruled.
- **One reader applies the declared value.** `routeUnder` returns the declared value for
  `repair-budget-spent` and `routeForCause` for every other cause. A verb that decides whose park this
  is reads it through `routeUnder`. Reading the setting any other way is the derivation 0376 bans.
- **This one route is declarable because it depends on who runs the lane.** Another repair round is
  a judgment about a stuck task, and a repo may want a person to make it. Every other cause's route is
  a fact about the machinery that parked the lane, so it stays fixed on the table.
- **Declaring `founder` narrows the driver's seat and never widens it.** Under `founder` a spent
  budget is a founder-routed park: `recipe unpark` refuses it on exit `12`, as it refuses every
  founder-routed park. No value routes a product call to the driver.
- **The setting says whose call the round is, not which account may record it.** The PR half of a
  grant is still gated by `capClearAuthors`, as 0393 left it.

**This amends ADR 0376 in part.** Its first binding constraint now reads: *a route is declared once,
on the cause, except that `parkCause.repairBudgetSpent` may re-declare the `repair-budget-spent`
cause's route and `routeUnder` is the one reader that applies it.* Every other clause of 0376 stands.

**This amends ADR 0378 in part.** Its driver seat on a spent budget is now the shipped value of a repo
setting rather than a route no repo can change. Its leaf, its finality, its three bounding properties
and its rationale requirement all stand.

**Binding constraints.**

- No park cause other than `repair-budget-spent` gains a declarable route without a record that
  amends this one.
- A verb that decides a spent budget's route reads it through `routeUnder`, never off the config key
  directly and never off the cause table alone.
- The shipped value stays `driver` while 0378's ruling stands.
- The setting is read from the tracked `.fabrika.jsonc` only. It decides whose authority a round is,
  so under ADR [0398](0398-machine-local-config-layer.md) it never joins the machine-local allow-list.

## Consequences

An adopter's driver reads its own repo's setting instead of phoenix's decision records, and a repo
that wants every spent budget in front of a person can say so.

`lane clear` does not read the setting, so under `founder` a driver's grant on a lane with no pull
request is held back only by `recipe unpark` and `operate`'s text. That gap is an accepted tradeoff,
not pending work: `lane clear` is also the human's grant path and cannot tell a driver from a person,
so [#9827](https://github.com/kamp-us/phoenix/issues/9827) rules making the verb enforce the setting
out of scope.

## Records

no vocabulary impact

Sources: epic [#9843](https://github.com/kamp-us/phoenix/issues/9843) and its approved plan
([comment 5852634112](https://github.com/kamp-us/phoenix/issues/9843#issuecomment-5852634112)); child
[#9827](https://github.com/kamp-us/phoenix/issues/9827); the tail review on
[#9921](https://github.com/kamp-us/phoenix/pull/9921); ADRs
[0376](0376-driver-seat-for-non-product-parks.md) and
[0378](0378-driver-seat-on-a-spent-repair-budget.md), each amended in part by this record, and
[0393](0393-lane-clear-grants-both-repair-budgets.md) and
[0398](0398-machine-local-config-layer.md);
[`packages/fabrika-cli/src/config/keys/park-cause.ts`](../packages/fabrika-cli/src/config/keys/park-cause.ts),
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts).
