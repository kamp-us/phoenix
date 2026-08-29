---
id: 0339
title: A park cause may be seated without a recipe row
status: accepted
date: 2026-08-29
tags: [fabrika, lane, pipeline, recipes, agents]
---

# 0339 — A park cause may be seated without a recipe row

**What this decides:** a token may be added to the closed set of park causes on its own. A
`KNOWN_PARKS` recipe row is what buys a park an autonomous clear; it is not the price of naming why
the lane parked.

## Context

`--cause` arrived with [#6480](https://github.com/kamp-us/phoenix/issues/6480) as the key
`recipe unpark` seats a park against, and two authorities in this repo then said opposite things
about how the vocabulary grows.

The `PARK_CAUSES` docblock in
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts) read a new
cause as owing a `KNOWN_PARKS` row "never one alone". ADR
[0302](0302-known-parks-clear-novel-routes-human.md)'s Consequences leaned the other way — "the
remedy is a park state that names its cause, not a smarter reader" — while its Decision said a
widening "needs a table row and a proving read, not an analogy". Read together, a driver could not
tell whether a cause with no recipe was legal or forbidden.

The coupling reading is what a driver actually hit.
[#6770](https://github.com/kamp-us/phoenix/issues/6770) collected four park classes observed live
over eight days, none of them seatable under it:

- a builder killed by an account session limit (lanes 6457, 6660, 6669, 2026-08-21);
- a reviewer killed by an API transport drop one step before posting its governance verdict
  (lane 7187, 2026-08-29);
- a builder whose provider returned `network_error` on every completion, which sat six days on
  ceremony alone (lane 5983, parked 2026-08-23, still parked 2026-08-29);
- an epic tail's review `FAIL` with no repair cell in the tail region to route into (epic #6629).

Each went in as a bare `BLOCKED`, and a bare `BLOCKED` is Novel by construction, so `recipe unpark`
refused every one on exit 12 and each cost a person. Meanwhile the vocabulary grew twice —
`head-behind-base` and `campaign-paused` — around the question rather than through it, and ADR
[0327](0327-ship-fail-routes-to-build.md) had already written the uncoupled reading into a record
without settling it: "A cause row alone is legal wherever no remedy verb exists; the pairing rule
binds the other direction."

The founder ruled the question in session on 2026-08-29, on
[#6770, comment 5465156777](https://github.com/kamp-us/phoenix/issues/6770#issuecomment-5465156777).
This record is a transcription of that ruling under ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md)'s citation arm, not a fresh decision.

**It amends ADR 0302 in part.** Everything 0302 decides about *clearing* stands unchanged: a park
clears without a human only on a registered recipe proven by a re-fold, classification still refuses
before any write, and no agent judges a park clear. What narrows is the scope of its "a table row and
a proving read" sentence, which read as governing the cause vocabulary too.

## Decision

**A `PARK_CAUSES` entry may be seated for its refusal message alone. A `KNOWN_PARKS` row is the
price of an autonomous clear, never the price of a name.**

The two tables answer two questions, and the ruling separates them:

- `PARK_CAUSES` answers *why did this lane park*. Its bar is that the reason is a real,
  distinguishable class a shell or driver can recognise at park time, spelled once as the clause a
  refusal quotes. Nothing else is owed.
- `KNOWN_PARKS` answers *may a verb walk this park out on its own*. Its bar is ADR 0302's,
  unweakened: a row, a `Clearance` constructor, and a re-fold that proves the task left the park.

A cause with no row is still Novel, and `recipe unpark` still refuses it at exit 12 with the ledger
untouched. What it gains is which park it is: `novelReason` in
[`packages/fabrika-cli/src/recipe/parks.ts`](../packages/fabrika-cli/src/recipe/parks.ts) already
carries the branch — `the park "<leaf>" names the cause "<cause>", which no recipe covers` — so a
named-but-unrecipe'd cause reads as a row somebody can write rather than a structural dead end. That
is the whole benefit being bought, and it is a driver's nomination of a recipe candidate, not a
clear.

**Nothing here lets a cause be composed at the point of use.** The set stays closed, `--cause` still
exits 35 on a token outside it, and a shell still names the cause that happened rather than the one
that is nearby. Seating a token is a change to this repo's source, reviewed like any other.

### The observed classes

`spawn-dead` is seated by this record, **with** a recipe row. It covers a shell — builder, reviewer
or shipper — killed by its provider before it recorded a terminal: a session limit, a transport
drop, a provider error. Its clearing condition is that the dead shell's residue is gone from the
lane, so the same brief can be dispatched again, and the dispatch itself is the test of whether the
provider is back. That is one class, four of the five observed instances, and one that reached every
shell role rather than only the one that takes a claim.

The rest are licensed rather than seated:

- **an epic tail's review `FAIL` with no repair cell** may be seated name-only when it recurs. No
  proving read is owed up front.
- **an assembly branch conflicting against a moved trunk** already has a git read that proves the
  conflict gone, so it may be seated with a row whenever somebody builds one.

## Consequences

A park that a recipe cannot clear now costs a person a *named* park instead of an anonymous one, and
the driver's park comment carries a class a reviewer can key a future row on. The friction ADR 0302
called deliberate stays exactly where it was — on the clear, which is where it earns its keep.

The cost is that the cause set will grow faster than the recipe table, and a reader who expects the
two to be the same length will be wrong. That is the shape the ruling chose: a name is cheap and a
clear is not.

`spawn-dead`'s recipe is bounded by nothing but the outage itself — it spends no lane retry, so a
provider down for hours can clear and re-park the same lane on each drive pass. Every lap files the
dead spawn's incident through the operator's own obligations, so the loop is loud rather than
silent, but a bounded form is unbuilt and tracked on
[#7318](https://github.com/kamp-us/phoenix/issues/7318).
