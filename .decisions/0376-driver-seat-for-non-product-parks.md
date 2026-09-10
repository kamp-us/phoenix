---
id: 0376
title: A park's route is read off its cause, and only a product call reaches the founder
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline, recipes, agents]
---

# 0376 — A park's route is read off its cause, and only a product call reaches the founder

**What this decides:** whose move a parked lane is now comes off the cause the park recorded. A cause
that names machinery is the driver's to work; the founder is reached only where the cause is a
product call.

## Context

The founder ruled this on the walk at
[#8807](https://github.com/kamp-us/phoenix/issues/8807). R5.1 is the ruling — *the default route out
of any park or spent budget is the driver, acting on its own recommendation and logging it, with the
founder routed to only when the cause is a product ruling* — and the authorization is verbatim on
[the ruling comment](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081): *"yes,
but i think fabrika proved enough that we can increase the cap"*, in the same turn as *"if you take a
look at one of most all the previous sessions, it's almost always about you telling me that something
is parked, and I'm telling you, yeah, just like do your recommendation… I want to save time, I want
to build important stuff, not pipeline failures."* Its stated trade-off is that the driver's
judgement lands unreviewed until the weekly machinery review, and the log is what keeps it auditable.

What the founder was describing is the shape of the corpus, not a lapse in it. ADR
[0302](0302-known-parks-clear-novel-routes-human.md) rules that a park clears without a human only on
a registered recipe proven by a re-fold, and *"Every other park goes to a person… No agent ever
judges a park clear."* That is why `recipe unpark` refuses a park no `KNOWN_PARKS` row covers on exit
12 with the ledger untouched — correctly, for the parks 0302 was written against. ADR
[0339](0339-park-cause-may-stand-alone.md) then uncoupled *naming* from *clearing*, so a cause could
be seated for its refusal message alone. Both hold. Neither answers the question the founder is
actually asking, because until now nothing on a park said **whose failure it was**: a worktree left
behind by a driver's own session and a paused campaign both folded to the same `Novel` park, and both
cost a person.

ADR [0378](0378-driver-seat-on-a-spent-repair-budget.md) moved exactly one park — the spent repair
budget — onto the driver's seat, and said so in as many words: *"That is one park, named, and not a
general licence."* This record is the general one R5.1 rules, and 0378's park is the instance of it
that shipped first.

## Decision

**Every park cause carries a route, and that field is the only place whose park it is is written
down.**

`ParkRoute` has two arms and no third:
[`lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts)'s `driver` means residue a driver
session owns or a read some verb can take again; `founder` means a judgment no verb may make on its
own account. An "either" would be the guess the field exists to delete. Every `PARK_CAUSES` row
declares one beside its meaning and its remedy, `routeForCause` is the whole derivation, and
`ParkRecipe` reads the route off that same table so no recipe row declares one a second time. Of the
rows shipped today only `campaign-paused` routes `founder` — a campaign's lifecycle is a product
call — and every other cause is machinery.

**A park that named no cause routes `founder`, and that is fail-closed rather than a default.**
Nothing named what went wrong, so nothing may attribute it to machinery. The two recipe rows keyed by
their leaf alone (`human:cp-approval`, `human:queue-stall`) take that arm, and both are already waits
on somebody else's act. The same reasoning gives `remedyForCause` its `null`.

**A driver-routed park with no recipe clears on the driver's own recorded rationale.** `recipe
unpark` gains a third arm beside `Recipe` and `Human`: where the cause routes `driver` and the repo
declares it, the verb records the `UNBLOCKED` itself. There is no proving read on that arm — that is
what makes the park novel — so a `--rationale` stands in its place and is required, because a
clearance nothing records is one nobody can review, and R5.1 grants the seat on the condition that
the log keeps it auditable. The rationale lands on the recorded event and reads back off the fold.
Exit `23` is the refusal that invites it; a `founder` route is exit `12` and the park comment,
exactly as before.

**The clearing arm is a repo's declaration, and it ships off.** `.fabrika.jsonc`'s
`parkCause.driverRouted` ships `refuse`, so `recipe unpark` behaves in an undeclaring repo exactly as
it did before this axis existed; `parkCause.uncaused` ships `record`, so a cause-less `BLOCKED` is
still recorded rather than refused at exit 52. Both defaults are today's behaviour, which is what a
shipped default is for. A repo whose shells all name their causes declares the strict values for
itself. The *route* field, by contrast, is live everywhere — it is data on the cause table, not a
flag.

**This amends ADR 0302 in part.** Its clearing mechanics stand whole: classification still happens
before any write, a recipe clear is still proven by a re-fold, and a park a recipe covers still
clears through the verb. What narrows is its actor sentence — *"Every other park goes to a person"* —
which now reads *every founder-routed park*. The driver was always a person; what 0302 could not say
is that the person is usually the one already at the wheel.

**This strengthens ADR 0339 rather than touching it.** Naming stays decoupled from clearing, and a
cause may still be seated with no recipe row behind it. What is added is the route: a
named-but-unrecipe'd cause is no longer automatically a person's to work, because the route says
whose it is. 0339's own worked examples — a killed shell, a provider's `network_error` — are all
machinery, and all of them route to the driver now.

**Binding constraints.**

- A route is declared once, on the cause. A verb that decides whose park it is by reading anything
  else is deriving a decision it should be relaying (ADR
  [0228](0228-scripts-relay-never-derive.md)).
- A park carrying no cause routes `founder`. No caller may read the absence as machinery.
- A driver's clear carries a rationale on the recorded event or it does not happen.
- The founder's seat is the product call. Widening a cause's route to `driver` because a park is
  inconvenient is the failure this record makes legible, not one it licenses.

## Consequences

The parks a driver used to hand upward — a worktree still holding a branch, a head behind its base,
an assembly or replay conflict, a dead shell, a missing preview render, a queue ejection — are the
driver's own, and clear on one call once the repo declares `driverRouted: "clear"`. `campaign-paused`
is the one that still leaves the machine, which is the shape R5.1 asked for.

A driver now spends judgment that lands unreviewed until the weekly machinery review. That is the
ruled trade-off, and the rationale on each recorded `UNBLOCKED` is what that review reads.

An undeclaring repo sees no behaviour change at all, so this lands as a route table plus an opt-in
rather than a flip under lanes already in flight.

## Records

Coins **driver**, **founder** (in the seat sense), and **park route**, defined in
[`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) beside the lane, in this pull request — the
definitions are short and the terms belong with the pipeline vocabulary they are read against.

Sources: the founder ruling at
[#8807, comment 5611016081](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081);
epic [#8810](https://github.com/kamp-us/phoenix/issues/8810) and its children
[#8815](https://github.com/kamp-us/phoenix/issues/8815) and
[#8816](https://github.com/kamp-us/phoenix/issues/8816);
ADRs [0302](0302-known-parks-clear-novel-routes-human.md) (amended in part by this record),
[0339](0339-park-cause-may-stand-alone.md) and
[0378](0378-driver-seat-on-a-spent-repair-budget.md);
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts),
[`packages/fabrika-cli/src/recipe/parks.ts`](../packages/fabrika-cli/src/recipe/parks.ts),
[`packages/fabrika-cli/src/recipe/unpark-verb.ts`](../packages/fabrika-cli/src/recipe/unpark-verb.ts),
[`packages/fabrika-cli/src/config/keys/park-cause.ts`](../packages/fabrika-cli/src/config/keys/park-cause.ts).
