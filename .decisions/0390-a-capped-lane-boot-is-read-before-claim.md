---
id: 0390
title: A capped lane boot is read before the claim, not queued
status: accepted
date: 2026-09-11
tags: [lane, operate, concurrency]
---

# 0390 — A capped lane boot is read before the claim, not queued

**What this decides:** an operator reads the seat count before it claims a lane, and a full
`laneConcurrencyCap` ends the run `LANE-WAITING` with nothing claimed and nothing written. No queue
file, no park directory, no new state in the cap itself.

## Context

`lane open` refuses at exit `51` when the lanes root holds `laneConcurrencyCap` seats, and it writes
nothing on that path. By then `operate` step 1 has already claimed the lane and the driver has
already spent an operator spawn. Because no `.fabrika/lanes/<n>` exists, `lane transition <n> BLOCKED`
has no ledger to append to, so the skill's park routes are unreachable and the run can only end
`STOPPED` — which reads to a caller as a defect in the driver rather than "come back when a seat
frees" ([#8809](https://github.com/kamp-us/phoenix/issues/8809)).

Three live instances were recorded on the issue: lanes #8808, #6165 and #8201. In two of them the cap
was not honestly full when the run started — dead lanes over closed issues held nine of the eleven
seats, and a driver blocked on the cap had to sweep them by hand. That accumulation was the larger
share of the problem and it is already fixed elsewhere:
[#8957](https://github.com/kamp-us/phoenix/issues/8957) (nothing sweeps dead lanes) and
[#8956](https://github.com/kamp-us/phoenix/issues/8956) (`lane archive` refuses a quarantined
directory as `#NaN`) both closed on 2026-09-10. With the sweep in place, a genuinely full cap is rare.

The seat accounting itself was never the defect. `packages/fabrika-cli/src/lane/concurrency.ts`
counts a lane only where its log folds to `active` **and** a live `lane claim` marker holds it, names
idle and unaccountable lanes separately, and states its own premise: there is no `--override` and no
environment escape, and raising the number in `.fabrika.jsonc` is the only way past.

## Decision

The founder ruled this on 2026-09-10 PT
([the ruling comment](https://github.com/kamp-us/phoenix/issues/8809#issuecomment-5625302931)):
sweep dead lanes and read the seat count before claiming, rather than build a waiting room the cap
can queue into.

1. **`operate` step 1 reads the seats before `lane claim`.** A full cap costs a read instead of a
   claim plus a boot attempt, and the run ends without a marker to release.
2. **A full cap ends `LANE-WAITING`, naming the earliest time to retry.** That terminal already
   exists in `operate` for the shipper's wait floor at exit `55`, so this adds no vocabulary and no
   new park state. Nothing is written to `.fabrika/lanes`, because nothing was booted. A full cap is
   a wait, and [ADR 0313](0313-a-queue-dwell-is-a-wait-not-a-park.md) already drew that line for the
   queue dwell: a condition that clears on its own spends no human.
3. **No waiting room.** A queue file or a park marker for an unbooted lane is a second copy of lane
   state sitting next to `.fabrika/lanes/<n>`, with nothing reconciling the two — and a cap you can
   queue into is a soft cap. That is incompatible with the hard-cap premise recorded in
   `concurrency.ts`, so option 1 on the issue is rejected outright, not deferred.
4. **`concurrency.ts` is unchanged.** No new flag, no environment escape, no park state, no human
   gate. `lane open` still refuses at `51` and still writes nothing, and that refusal stays the
   backstop.
5. **The check-then-act race is accepted.** Two drivers can both read a free seat and both claim;
   the loser hits `51` at `lane open` and takes the same `LANE-WAITING` ending one step later. Paying
   for a lock to close a race whose fallback is already correct buys nothing.

Rejected with it: "do neither — raise the cap and accept the wasted dispatch". The waste is a whole
operator spawn per blocked dispatch, and raising the number to avoid a bad answer trades the cap's
whole purpose for a message.

## Consequences

- `claude-plugins/fabrika/skills/operate/SKILL.md` step 1 is what changes: the seat read moves ahead
  of `lane claim`, and `LANE-WAITING` gains its second cause. That edit is a follow-up build, not
  this record.
- No verb prints the seat count today without attempting a boot, so the follow-up picks how step 1
  reads it. Whatever it picks writes nothing and claims nothing — that is the whole point of moving
  the read earlier.
- A driver dispatched into a full pipeline now returns a retry time instead of a code, so a sweep can
  re-dispatch the same lane without a human noticing first.
- Nothing records that a lane was asked for and could not start. That is the cost of refusing the
  waiting room, and it is accepted: the lane number is unclaimed and the next dispatch starts clean.
