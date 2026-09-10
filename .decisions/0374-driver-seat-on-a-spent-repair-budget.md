---
id: 0374
title: A spent repair budget parks to its driver, and the driver's own grant is a recorded clearance
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline, state-machine]
---

# 0374 — A spent repair budget parks to its driver, and the driver's own grant is a recorded clearance

**What this decides:** the leaf a spent repair budget falls into is renamed so a recipe can see it as
a park, its finality is unchanged, and the clearance that reopens its door may now be recorded by the
lane's driver as well as by the founder — through `lane clear`, on the lane that has no pull request
for `build clear` to read.

## Context

The founder ruled two things on the walk at
[#8807](https://github.com/kamp-us/phoenix/issues/8807), verbatim: *"yes, but i think fabrika proved
enough that we can increase the cap"*
([the ruling comment](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081)). R5.2
raises the per-task cap to 3. R5.1 is the one this record is about: *the default route out of any park
or spent budget is the driver, acting on its own recommendation and logging it, with the founder
routed to only when the cause is a product ruling* — and its stated trade-off is that *"the driver's
judgement lands unreviewed until the weekly review; the log is what keeps it auditable."*

Three live records stand in the way of implementing that carelessly, and all three are right.

- ADR [0297](0297-frozen-is-a-park-not-an-end.md) rules that the spent-budget leaf is a `final` that
  carries an `on`: it stays in `finals` and `errorFinals`, its phase folds, the lane trips loud, and
  the door out stays walkable. Its Context rejects dropping `"type": "final"` by name — *"a frozen
  lane would stop reading as tripped, and its phase would never fold at all, so the run would hang
  instead of ending loud."*
- ADR [0312](0312-event-anchored-retry-budget.md) rules that a walkable non-`PASS` route comes from a
  recorded `<TASK>.CLEARED` event and from nothing else, and makes a resume without one a stated
  refusal (`applyEvent`'s `unbudgeted-resume`) rather than a silent `active`.
- ADR [0341](0341-a-failed-epic-review-is-a-park.md) rules the same shape for the epic tail's own
  spent review budget: `human:epic-review` keeps its finality, gains the `UNBLOCKED` door, and gets
  its own `operate` routing row so a driver does not derive the shape from the state's name. It
  states the seat independently of 0297 — *"Budget comes from a founder clearance recorded with
  `build clear` and from nowhere else."*

The actual defect R5.1 answers is narrower than any of them, and none of them caused it. `frozen` was a
park no *recipe* could see: `recipe/parks.ts`'s `isPark` matches `blocked` and `human:*` and matched
`frozen` never, so a task at its cap folded to `NotParked` and no park cause, no route and no recipe
row could key on it. Underneath that, the one verb that grants a round —
`build clear` — is pull-request-keyed from its first line (`openPull`, `listComments(repo, pr)`,
`membershipAt(repo, baseRef)`), and an epic child and a chore lane open no pull request. So a child at
its cap had no door at all. That is the whole of
[#6525](https://github.com/kamp-us/phoenix/issues/6525) and
[#8779](https://github.com/kamp-us/phoenix/issues/8779).

A first attempt at this slice dropped `"type": "final"` from the leaf to make the resume
unconditional. Three range-scoped gates failed it on one finding: the drop takes the leaf out of
`errorFinals`, which is the set `unbudgeted-resume` keys on, so a bare `UNBLOCKED` walked the door at
a spent budget, nothing counted the walks, and the founder's cap of 3 stopped being machine-enforced
on every newly emitted lane. This record is what that repair rests on.

## Decision

**The leaf's name changes and its finality does not.** `frozen`'s spent-budget role moves to
`human:budget-spent` in all three machine sources — the coder template, the emitted child region and
the emitted epic tail — and it keeps `"type": "final"` beside its `UNBLOCKED` door, exactly as 0297
rules. `finals`, `errorFinals` and `openFinals` all hold it; the phase folds, the lane reads
`tripped`, and `applyEvent`'s `unbudgeted-resume` refusal binds every lane emitted from here on. ADR
0297 is upheld whole, and 0312's *"from the `CLEARED` event and from nothing else"* is unchanged.

What the rename buys is the thing that was actually broken: `isPark` matches the new name, so the
park is visible to `recipe/parks.ts`, and it carries a structural cause — `repair-budget-spent`,
bound to the leaf in `STRUCTURAL_PARK_CAUSES` because no `FAIL` may carry a typed `--cause` — whose
route is `driver`. `frozen` survives as the state an abandoned child boots into and nothing
transitions to it any more.

**The driver may record a clearance, through `lane clear`.** This is the one mechanic of 0297 and
0312 that R5.1 moves. 0297 says a clearance is *"recorded through `build clear`"*; 0312 says of
`CLEARED` that *"no human records it with `lane transition`, `build clear` appends it"*. Both are
amended to this: the *event* is unchanged and remains the only source of a repair budget, and the
*seat* is now two.

- `build clear` is unchanged in every respect. Where a pull request carries the founder's grant, it
  stays the verb, `cap-clearance.ts`'s derivation is untouched, and the board half stays on GitHub
  per ADR [0283](0283-local-ledger-holds-ownable-orderings.md).
- `lane clear` is the seat for a lane with no pull request. It appends the same `<TASK>.CLEARED`
  entry through the same `applyClearance`, so both readers keep one derivation. It is not a widening
  of `build clear`, which epic [#8810](https://github.com/kamp-us/phoenix/issues/8810) names an
  explicit non-goal: it reads no board, holds no ACL, and posts no marker.

**The epic tail's park collapses into the same leaf, and 0341 is amended with the other two.** R5.1
reads *"any park or spent budget"*, which covers the tail as plainly as it covers a child, so the
tail's three `FAIL` arms now fall through to `human:budget-spent` and `human:epic-review` is gone
from the machine. Everything 0341 ruled about that park survives under the new name: the same
`final` beside the same `UNBLOCKED` door, the same `LANE-PARKED` reading, and its own routing row in
`operate`. The one clause that moves is the seat — the tail's grant is recordable through
`lane clear` by the driver, bounded by the same three properties below as every other grant, and
`build clear` remains the founder's seat on the pull request the tail carries. A lane emitted before
this change still carries `human:epic-review`, still parks, and is cleared the way 0341 already
says.

**Three properties keep the driver's seat bounded, and they are what hold the cap now.**

- **The round is derived, never typed.** `lane clear` reads the round off the task's own declared cap
  against the grants already in its log (`capWith`), so one call grants exactly one round. A caller
  cannot type a number ahead and buy several, and it refuses a task that still has budget to spend.
- **Every grant is a line.** One `CLEARED` per round, set-semantic by that round, so a re-run or a
  concurrent second driver buys nothing. A driver looping the door mints no rounds: each is
  countable in the log, which is precisely what R5.1's trade-off rests on.
- **The refusal still stands between the two.** A resume out of the park with no grant behind it is
  `unbudgeted-resume` with the log unappended, on the shipped template as on every emitted machine.

**The driver records the `UNBLOCKED` out of this park too, and that is the last amendment.** 0297's
binding constraint reads *"`operate` never records the `UNBLOCKED` itself — clearing a park stays a
human's event"*, and ADR [0302](0302-known-parks-clear-novel-routes-human.md) narrows the exception
to a recipe verb. Neither reaches this park: `repair-budget-spent` carries no `remedy`, because there
is no read a recipe can rerun to prove a repeatedly-failed artifact right, so `recipe unpark` classes
it `Novel` and refuses it with the ledger untouched — correctly. R5.1 is what opens it: the driver is
the seat for a spent budget, so the driver runs `lane clear` on its own recommendation and then
records the `UNBLOCKED` itself. That is one park, named, and not a general licence: every other
`human:*` park keeps 0297's and 0302's routing exactly as they read.

**A mandatory rationale is the driver's audit.** `lane clear` refuses an absent or blank
`--rationale` and records it on the `CLEARED` line. A founder's grant is reviewable on the pull
request it was posted to; a driver's is reviewable on that line or nowhere, and R5.1 grants the seat
on the condition that the log keeps it auditable.

**Binding constraints.**

- The spent-budget leaf stays a `final` carrying an `on`. A machine source that gives it a door by
  dropping its finality takes it out of `errorFinals`, which retires the resume refusal for every
  lane emitted afterwards — the defect this record's repair round exists to close.
- A budget still comes from a recorded `CLEARED` and from nothing else. No flag on a resume grants a
  repair round; the wait axis's `--grant-wait` is a different budget and buys no repair round.
- One grant is one round, keyed by the round it clears.

## Consequences

An epic child and a chore lane have a door out of their cap for the first time, which closes #6525
and #8779 — neither shrinks: both report the same dead end, and the dead end is gone rather than
narrowed.

A driver now holds a seat a founder used to hold, and spends it unreviewed until the weekly
machinery review. That is R5.1's ruled trade-off, not a side effect. The `rationale` on each
`CLEARED` line is what that review reads.

The cost 0297 named — that a park can be walked repeatedly — is now bounded rather than deliberate:
each walk costs a recorded grant, and a grant is one round.

## Records

No `.glossary/TERMS.md` row. Following 0297 and 0312, the lane machine's leaf names and event
vocabulary are defined with the machine and the
[`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) skill.

Sources: the founder ruling at
[#8807, comment 5611016081](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081);
epic [#8810](https://github.com/kamp-us/phoenix/issues/8810) and its child
[#8820](https://github.com/kamp-us/phoenix/issues/8820);
[#6525](https://github.com/kamp-us/phoenix/issues/6525),
[#8779](https://github.com/kamp-us/phoenix/issues/8779);
ADRs [0297](0297-frozen-is-a-park-not-an-end.md), [0312](0312-event-anchored-retry-budget.md) and
[0341](0341-a-failed-epic-review-is-a-park.md), each amended in part by this record;
[`packages/fabrika-cli/src/lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts),
[`packages/fabrika-cli/src/lane/fold.ts`](../packages/fabrika-cli/src/lane/fold.ts),
[`packages/fabrika-cli/src/lane/clear-verb.ts`](../packages/fabrika-cli/src/lane/clear-verb.ts),
[`packages/fabrika-cli/src/recipe/parks.ts`](../packages/fabrika-cli/src/recipe/parks.ts),
[`packages/fabrika-cli/src/cap-clearance.ts`](../packages/fabrika-cli/src/cap-clearance.ts).
