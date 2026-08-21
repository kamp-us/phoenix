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
  refused with `NoCellError`, because a park is not a state a landing is recorded from. The lane was
  cleared by hand with `UNBLOCKED` — the right route, taken late, on a park that was never owed.

The chore machine already drew this line — `recipe route` folds a not-yet-clear known park to `WIP`
and a driver re-folds it. The coder machine's `ship` had no equivalent.

## The decision

**`ship:queued` is the wait cell.** It is reachable from `ship` on `WIP`, re-enters itself on a
further wait, reaches `shipped` on a landing, routes an ejection back into `build`, and escalates to
`human:queue-stall` when its own budget is spent. It is not a park: the name carries no `human:`
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

**A founder's cleared round buys a repair round and never a longer wait.** ADR
[0312](0312-event-anchored-retry-budget.md) anchors the repair budget to a recorded
`CLEARED` event, and that event raises `maxRetries` alone. `maxWaits` is a declared constant no
recorded event moves — which is the same separation from the other side: the founder is clearing a
review round, and handing the merge queue three more turns of the crank is not what they granted.

Splitting the counters also narrows what a *state* being guarded means. `guardedStates` — the set
0312's resume refusal reads, where the state comes back and the budget does not — now holds only the
states whose guarded route out spends `retries`. A wait-guarded cell is no resume hazard: its spent
fallthrough is a park that names the stall, not a fall back into the error final the resume just
left.

**The shipper's horizon does not move.** `ship reconcile` polls exactly as far as it did. The waiting
moved out to the driver, one read per pass — `ship reconcile <pr> --polls 1`, whose answer the driver
relays rather than derives (ADR [0228](0228-scripts-relay-never-derive.md)): `landed` → `LANDED`,
`unresolved` → `UNRESOLVED`, `ejected` → `EJECTED`, `parked` → `UNKNOWN`. The driver never counts
re-folds and never decides the wait is over; the cell's own budget does that.

**A park keeps its one exit.** `human:cp-approval` gains nothing here. An already-parked lane whose
PR then merged leaves the way every park is left — a recorded `UNBLOCKED` back to the state it came
from, and the landing recorded from there. That is lane 6462's route out, it is the one that lane
actually took on 2026-08-20, and it is the only one ADR
[0302](0302-known-parks-clear-novel-routes-human.md) permits: a park is cleared by a registered
recipe proven by a re-fold, or by a human's `UNBLOCKED`, and never by a second exit cell that skips
both. A `DONE` cell would have been that second exit, reachable by any driver relaying a `ship`
token, so what looked like a convenience was a widening of the rule 0302 states — and 0302 says
widening it needs a table row and a proving read, not an analogy.

**The wait's own escalation gets its own park, `human:queue-stall`.** It could not be
`human:cp-approval`. The escalation is driven by a `WIP`, and `report.ts` refuses a park cause on any
non-`BLOCKED` event, so a spent queue wait structurally cannot carry one — which is exactly the key
`recipe/parks.ts`'s control-plane row matches (`cause: null`). A stall landing there would be swept
as a §CP park and cleared by reading an approval nobody was waiting on, the failure that table's
cause key exists to prevent. Its own leaf carries no row, so `classifyPark` reads it as novel and
routes it to a human, which is what a spent wait needs. A human clears it with `UNBLOCKED` like any
other park; the lane resumes at `ship:queued` and a re-read decides it from there.

**Lanes already booted are migrated, not left behind.** `lane open` places a byte-identical copy of
the template into each lane and refuses to overwrite one afterwards, so a template edit reaches lanes
booted after it and no lane already on disk — while `report.ts`'s token map is code and reaches all
of them at once. Left alone, that combination is worse than the bug: every booted lane's shipper
would report `QUEUED`, now mapped to `WIP`, against a frozen `ship` state holding no `WIP` cell, and
the ordinary success path would refuse. So this change ships with `lane migrate`, which replaces a
booted lane's `workflow.json` with the committed template **only** where the swap is provably inert:
state is the event log replayed from scratch with no snapshot, so the swap is safe exactly when the
existing log folds to the same per-task leaf state through both machines. Anything else — a log that
will not replay, or one that folds somewhere new — is named and left untouched for a human, because
relocating a lane is not migrating it. `lane migrate --check` is the same judgement with the write
withheld.

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

## Amendment — 2026-08-20: an epic lane already on disk drains on the machine it was emitted with

Founder ruling,
[2026-08-20](https://github.com/kamp-us/phoenix/issues/6683#issuecomment-5361645200), on
[#6683](https://github.com/kamp-us/phoenix/issues/6683). This amendment transcribes it.

The migration above covers a *booted* lane, whose machine is a copy of a committed template. An epic
lane's machine is **generated** by `lane emit` from the epic body's topology, so there is no template
to bring it up to and `lane migrate` reports it `generated` and writes nothing. Five epic lanes were
on disk when the `WIP` remap landed, each with a tail `ship` state holding cells for `DONE` /
`BLOCKED` / `FAIL` and none for `WIP`.

**They are not migrated. They drain on the machine they were emitted with**, and no regenerate path
is built.

**The route out when one is hit.** An old-shape epic tail whose shipper reports its ordinary `QUEUED`
now maps to `WIP` and refuses with `NoCellError` against that `ship` state. The refusal leaves the
log byte-identical, so nothing is lost — the driver records the lane's terminal by hand from the
board's truth with `lane transition`: on a merged PR, `UNBLOCKED` first if the lane is sitting in a
park, back to the state it came from, then `DONE` from `ship`. That is the same fold lane 6462 took
and the one the park route above already names. If the epic still has phases to run, the lane is
re-emitted — which means retiring its directory by hand and running `lane emit` fresh, since
`placeMachine` refuses over a lane that already exists and that refusal is untouched here.

**Two other answers were considered and rejected**, so the next reader does not re-open them:

1. **Teach `lane migrate` to regenerate a `generated` lane** — re-run `emitMachine` and judge the
   candidate by the replay test the verb already applies to a template graft. Rejected: `emitMachine`
   needs the epic's board state, which `lane migrate` reads nothing of today. That is a new read and
   a new failure mode inside a verb whose whole guarantee is that it writes only where the swap is
   provably inert.
2. **Give `lane emit` a `--regenerate`** that overwrites an existing epic lane behind the same
   proving fold. Rejected: the refusal over an existing lane is there so a lane is never re-booted
   over, and carving an exception into it costs more than the five lanes are worth.

`lane migrate`'s `generated` verdict therefore stays a skip, and its reason points a reader here
rather than stating only that the machine was generated.
