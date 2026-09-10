---
id: 0373
title: A shell's claim ends a fifth way — retracted on a budget-proved death, inside the park its driver already recorded
status: accepted
date: 2026-09-10
tags: [fabrika, pipeline-hardening, claim]
---

# 0373 — A shell's claim ends a fifth way — retracted on a budget-proved death, inside the park its driver already recorded

**What this decides:** when a lane is parked on `spawn-dead` and the build claim its dead shell left
is older than the budget for the kind of work that shell took, `recipe unpark` retracts the marker
itself and re-reads the board to prove it gone. No adopt marker, no `build release`, no person. The
horizon is per shell kind — 40 minutes for a build, 15 for a review, 10 for a ship — and there is no
heartbeat.

This record **amends ADR [0295](0295-board-attested-claim-succession.md) and ADR
[0215](0215-claim-identity-continuity-proof.md) §5 in part.** 0295 says "no TTL, no lease, no steal,
and no eviction inferred from absence"; 0215 §5 bans "evicting a claim on age, on TTL, on session-id
mismatch, or on any inference from absence", and its summary sentence reads "a claim is never taken
away merely for looking old". What follows is an age test, and pretending otherwise would leave the
corpus lying about its own code. So: **the age ban is narrowed to exactly the population below, and
stands everywhere else.**

## The ruling this transcribes

The founder walked this slice on 2026-09-09 (PT) and the ruling is recorded on
[#8821](https://github.com/kamp-us/phoenix/issues/8821), in that issue's `## Amendment — 2026-09-10`
section. Asked how a lane decides a shell is dead, given a heartbeat the shell writes or a timeout
per kind of work read off the claim marker's start time, the founder chose the timeout and rejected
the heartbeat. The per-kind numbers are starting guesses, tuned in the weekly machinery review beside
the machinery-lap budget. A claim past its budget is released, counted as a machinery lap
([#8819](https://github.com/kamp-us/phoenix/issues/8819)), and re-dispatched.

## Context

0295 answered a driver session dying and stranding its builders' markers: the successor attests on
the board with `build adopt`, then releases. That is the right shape for a *session* whose death
nobody can prove — anyone may adopt a live session's claim, so the guard is disclosure plus the ACL.

It is the wrong price for a *shell*. A provider kills one spawned shell several times a day — a
session limit, a transport drop, a `network_error` on every completion — and each one costs a person
two hand-run verbs for a failure nobody chose. The `spawn-dead` park exists precisely because the
driver saw it happen and recorded it. Everything the succession protocol buys with an attestation is
already on the ledger; what was missing was the authority to act on it.

Nothing weaker would do. A shell writes nothing between its claim and its terminal, so the only
instant on disk is the one the work began at, and the founder ruled out adding a heartbeat that would
change that. Liveness is therefore not observable, and the honest statement of what a budget proves
is: *this is the only definition of death available here.*

## Decision

**A build claim marker may be retracted on its own age, and only where all five of these hold
together:**

1. The lane is parked, the park's cause is `spawn-dead`, and `recipe unpark` is clearing it. A
   driver recorded that park on the lane's append-only log after watching its own spawn stop — so
   the age test never runs as a reader-side eviction, and no verb that merely *reads* a claim ever
   retracts one.
2. The marker's age exceeds the budget for the kind of work its shell took
   ([`shell-budget.ts`](../packages/fabrika-cli/src/lane/shell-budget.ts)), read off the marker's own
   creation instant.
3. Every marker carrying that lane's token is retracted, never one off the stack — a peeled stack
   leaves the next-oldest reading as a live claim.
4. The board is **re-read** afterwards and shows no holder. A claim that still reads held is
   `READBACK_MISMATCH` (exit `9`), never a clear.
5. Anything short of that answers with its own arm and retracts nothing: an unreadable board, an
   unparseable instant, and a claim still inside its budget are each `Unknown` or `Alive`, and a
   claim inside its budget holds the park at exit `13`.

**What is still banned, unchanged.** No lease. No steal by a foreign lane. No eviction inferred from
absence outside the five conditions above. No age test on a claim whose lane is not parked on
`spawn-dead`. No TTL in `build claim`, `build confirm`, `build release`, `resolveOwnership`, or any
other reader. 0295's adopt-then-release path is untouched and remains the whole answer for a claim no
budget covers — a dead *session's*, or a park with a different cause.

**The horizon is per kind of work and carries its derivation.** One number for the pipeline is wrong
in both directions at once: wide enough for a builder's construct → check loop, it strands a dead
shipper for the better part of an hour; tight enough for a shipper, it evicts a live builder
mid-loop. Each row in `SHELL_BUDGETS` states the shape of work its number measures, and the ordering
`build > review > ship` is what the shape fixes and tuning may not break.

**A death is a machinery lap, not a repair round.** The shell died; nothing about the artifact was
judged. The `SHELL-DEAD` terminal maps to the machine's `LAP` and carries `spawn-dead` as its cause
with no `--cause` typed, so it spends the lap budget and the child's repair rounds are untouched.
Every shell state in the coder machine carries a `LAP` edge, so the terminal is recordable from every
state that carries a budget.

## Why the alternatives lost

- **A heartbeat the shell writes.** Ruled out by the founder in the walk. It would make liveness
  genuinely observable and would need no age test at all — and it costs a write per shell per
  interval, a new marker kind, and a shell that must survive to write it, which is exactly the thing
  that is failing.
- **Hold at 0295 — adopt then release, by hand, every time.** Priced at two founder-run verbs per
  dead shell, several times a day, for a failure the driver already watched happen and already
  recorded. That is the price 0295 itself refused to keep paying for a *session*; a shell dies far
  more often.
- **A general TTL on every claim read.** The shape 0215 §5 and #5752 refused, and this record does
  not revive it: a slow-but-live builder must never be evicted by a reader that knows nothing about
  why it is slow. Condition 1 is what keeps that ban intact.

## Consequences

- `recipe unpark`'s `spawn-dead` row now clears a park a person used to clear, and the two hand verbs
  it required are gone from that path only.
- **A live shell can be evicted, and the bound is named.** A builder still working at minute 41,
  whose lane a driver has already parked `spawn-dead`, loses its claim. The outcome is a re-run
  contention resolved by the ordinary earliest-authorized tiebreak — the evicted shell's own next
  `build confirm` refuses — never a double-implement. The numbers are guesses, so this is the risk
  the weekly machinery review is tuning against, and widening a budget is the fix for it.
- 0295's and 0215's `status:` lines record this amendment; their bodies are untouched, per the
  accepted-ADR immutability rule.
- [`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md)'s stranded-claim obligation cites
  this record, so the skill states one rule where it used to state a ban and its exception.
- The `.glossary` gains nothing: **shell budget** names a mechanic inside one keyspace, exactly as
  0215's *presence witness* does, and its home is this record plus the `shell-budget.ts` docblock.
