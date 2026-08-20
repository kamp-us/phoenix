---
id: 0313
title: A clean PR still in the merge queue is a wait the driver re-folds, not a human park
status: accepted
date: 2026-08-20
tags: [fabrika, lane, pipeline, ship, state-machine]
---

# 0313 — A clean PR still in the merge queue is a wait the driver re-folds, not a human park

**What this decides:** the coder machine gains a non-human wait cell out of `ship`. A shipper that
ends with the PR still in the merge queue records `WIP`, the lane folds to `ship:queued`, and the
driver re-reads the queue on a later pass. A human is spent only when the PR leaves the queue
un-merged or the wait's own bounded re-folds run out.

Founder ruling, [2026-08-20](https://github.com/kamp-us/phoenix/issues/6189#issuecomment-5360244073),
restating [2026-08-19](https://github.com/kamp-us/phoenix/issues/6189#issuecomment-5346739403). This
ADR transcribes that ruling; the choice is the founder's, not this record's.

## The problem

`ship reconcile` watches an enqueued PR for a bounded ~480s and answers `unresolved` when the PR is
still in the queue at that horizon — an honest answer that its own contract calls "neither a landing
nor a failure". The lane machine had nowhere to put it. `UNRESOLVED` mapped to `BLOCKED`, `BLOCKED`
out of `ship` folds to `human:cp-approval`, so every clean lane that dwelt past the horizon parked on
a human for a merge that was going to land on its own.

Twice, measurably:

- [#6178](https://github.com/kamp-us/phoenix/pull/6178) sat ~13m45s in the queue against the ~480s
  horizon and merged ~1.7x past it, long before anyone would have read the park.
- Lane 6462's PR merged 29 seconds before its `BLOCKED` was written. The follow-up `LANDED` was then
  refused: `human:cp-approval` held no `DONE` cell, so `NoCellError` left a merged PR's lane stuck in
  a park with no route out.

The chore machine already drew this line — `recipe route` folds a not-yet-clear known park to `WIP`
and a driver re-folds it. The coder machine's `ship` had no equivalent.

## The decision

**`ship:queued` is the wait cell.** It is reachable from `ship` on `WIP`, re-enters itself on a
further wait, reaches `shipped` on a landing, routes an ejection back into `build`, and escalates to
`human:cp-approval` when its own budget is spent. It is not a park: the name carries no `human:`
prefix, so `recipe/parks.ts`'s `isPark` reads it as ordinary work and no park sweep touches it.

**Both queue terminals record `WIP`.** `UNRESOLVED` no longer maps to `BLOCKED`, and `QUEUED` no
longer maps to `DONE`. Only `LANDED` and `ALREADY-MERGED` are `DONE`, because those are the two
terminals that read a merge back — `QUEUED` folding a lane to `shipped` over a merge nobody observed
was the same lie as `UNRESOLVED` parking one over a merge that was fine. Every genuine shipper block
still maps to `BLOCKED` and still folds to `human:cp-approval`, so
[#5820](https://github.com/kamp-us/phoenix/issues/5820)'s separate question — which park cell a real
block lands in — is untouched.

**The wait spends its own budget.** A guarded two-arm array in a lane machine used to mean one thing:
retry while `retries < maxRetries`. It now means "loop while a budget remains", and *which* budget is
read off the event: `FAIL` is a repair round and spends `retries`, every other event is a wait and
spends `waits` (`WAIT_BUDGET`, 3). Riding one counter would have let a PR that dwelt in the queue
arrive at its first real FAIL with no repair rounds left — a repair budget spent on the queue's clock
rather than on the work. The recognition stays structural, off the event's own polarity: no guard or
action name is dereferenced, which is the property `lane/machine.ts` has held since #5673.

**The shipper's horizon does not move.** `ship reconcile` polls exactly as far as it did. The waiting
moved out to the driver, one read per pass — `ship reconcile <pr> --polls 1`, whose answer the driver
relays rather than derives (ADR [0228](0228-scripts-relay-never-derive.md)): `landed` → `LANDED`,
`unresolved` → `UNRESOLVED`, `ejected` → `EJECTED`, `parked` → `UNKNOWN`. The driver never counts
re-folds and never decides the wait is over; the cell's own budget does that.

**`human:cp-approval` gains a `DONE` cell.** A lane parked there whose PR then merged can record
`LANDED` and fold to `shipped`. That is lane 6462's named route out, and it weakens nothing: the only
tokens that reach `DONE` are the two that read a merge back, and a merged control-plane PR is one
whose approval happened.

## What this costs

An ejection out of the wait cell routes to `build` (spending a retry), not to a human park. The
ruling named "the PR left the queue un-merged" as an escalation condition; #5807 had already decided
an ejection is repair work this lane retries, and that answer survives here — a human is spent only
when the repair budget itself runs out. A genuine block observed on a re-fold pass (`REFUSED`,
`AWAITING-CP-APPROVAL`, `UNKNOWN`) still parks, which is the ordinary block route rather than a third
escalation path out of the wait.

An epic run's tail gets the same cell for the same reason: the tail is where an epic meets the merge
queue. A child region has no `ship` and reaches no queue, so it needs none (ADR
[0285](0285-epic-machine-ends-in-review.md)).
