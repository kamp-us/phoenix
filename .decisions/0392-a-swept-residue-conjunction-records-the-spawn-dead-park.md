---
id: 0392
title: A swept residue conjunction may record the spawn-dead park a driver used to watch for
status: accepted
date: 2026-09-15
tags: [fabrika, pipeline-hardening, claim, lane]
---

# 0392 — A swept residue conjunction may record the spawn-dead park a driver used to watch for

**What this decides:** `lane recover --spawns` may append `BLOCKED --cause spawn-dead` to a lane's
log on its own reads, with no driver watching anything stop. It retracts no claim. The retraction
stays where ADR [0373](0373-shell-budget-claim-retraction.md) put it, under all five of that
record's conditions, and this record replaces the evidence its **condition 1** demanded.

This record **amends ADR [0373](0373-shell-budget-claim-retraction.md) in part**, on one arm and no
other. 0373's condition 1 reads "a driver recorded that park on the lane's append-only log after
watching its own spawn stop — so the age test never runs as a reader-side eviction", and its "What
is still banned" section reads "no age test on a claim whose lane is not parked on `spawn-dead`".
The sweep below reads a claim's age against a lane nobody has parked, and it does so to write the
park. Naming that anything other than an amendment would leave the corpus lying about its own code,
which is the sentence 0373 wrote about itself when it crossed 0295 and 0215.

## The ruling this transcribes

The founder ruled this slice on
[#9241](https://github.com/kamp-us/phoenix/issues/9241#issuecomment-5687141320), 2026-09-15:

> Question 1: yes. An unattended sweep may record the `spawn-dead` park itself, on the conservative
> predicate only: a build claim standing, no lane branch on origin, no PR, no worktree under the
> lanes root. Add one guard so #9092's burn cannot repeat: the claim must be older than a floor
> (30 minutes; a config key with that default) because a live builder posts its claim before it cuts
> a branch. Under the floor the sweep names the lane and does nothing.

## Context

Lane 7778 read `issue: build` for five days. Its builder posted a claim marker and died with its
parent session two minutes later — no branch, no worktree, no PR — and the lane held a seat against
`laneConcurrencyCap` until a person re-read it by hand. Every fact the eventual recovery stood on
was equally readable on the first day.

0373 gave `recipe unpark` the authority to retract that claim, but only inside a park somebody had
already recorded, and recording it was a driver's act. When the driver is the thing that died, no
part of the chain runs. The authority 0373 granted is unreachable for exactly the failure it was
granted for.

## Decision

**An unattended sweep may append the `spawn-dead` park, and only where all four of these hold
together:**

1. A build claim stands on the task's issue and its age exceeds the **build** budget in
   [`shell-budget.ts`](../packages/fabrika-cli/src/lane/shell-budget.ts), read off the marker's own
   creation instant through the same `claimStanding` predicate `recipe unpark` reads.
2. No lane branch for that issue exists in this clone.
3. Nothing stands on the surface a builder in this lane's **role** publishes to: an open pull request
   whose body links the issue on a single lane or an epic tail, and the lane branch of conjunct 2 on
   an epic child, which opens no pull request by design.
4. Each of those is a read that **answered**. An unreadable board, an unreadable instant, an
   ambiguous set of pull requests and a claim inside its budget each answer with their own row and
   change nothing on the ledger.

**No claim is retracted here.** The marker is left exactly as found, and ending it stays
`recipe unpark`'s act under 0373's five conditions unchanged — same budget, whole stack, re-read,
`READBACK_MISMATCH` on a disagreement.

### What replaces condition 1's watched-spawn evidence

Condition 1 was not asking for a human. It was asking for evidence that the shell is gone which is
independent of the claim's age, so that the age test could never stand alone as a reader-side
eviction. A driver's watching supplied that, and conjuncts 2 and 3 above supply it too — and supply
more of it.

A driver who watched a spawn stop read no residue at all. Its park is recordable over a builder that
had already pushed a branch and opened a pull request; 0373 admits exactly that park, and `recipe
unpark` then retracts the claim inside it. This sweep's park cannot be recorded over that lane: a
branch carrying the dead builder's commits is a `working` row, and so is a published pull request.
So the population this record opens is **strictly inside** the population 0373 already admitted, and
the evidence standing behind it is strictly more than a watched stop.

**The ban this leaves intact is the one 0373 named.** A general TTL on every claim read stays
refused: nothing here evicts, nothing here reads a claim outside this conjunction, and no reader
`build claim`, `build confirm`, `build release` or `resolveOwnership` gains an age test. What is
narrowed is which fact licenses the park, and nothing else.

### The floor is the build budget, and there is one number

The ruling named a 30-minute floor behind a config key. This record settles it at
`BUILD_CLAIM_BUDGET_MINUTES` — the 40-minute build budget already in `shell-budget.ts` — and it is a
correction on a mechanism, not a decline of the guard.

A floor below the retraction budget records a park nothing can clear. `recipe unpark`'s `spawn-clear`
row calls `reclaimDeadClaim` against the build budget and refuses at `PARK_HOLDS` on a claim inside
it, so a lane parked at minute 31 folds `blocked`, fails its own clearance for ten minutes, and
routes to a human — the outcome this ticket exists to remove. One number for both steps means every
park this sweep records is a park the next `recipe unpark` clears on the same proof.

It also keeps the guard the ruling asked for and makes it stricter: 40 minutes of silence with no
branch is a longer wait than 30, and the #9092 burn it guards against is a live builder read as dead.
The number is already a tuned surface — `SHELL_BUDGETS` carries its derivation at the number and the
weekly machinery review moves it — so a second key would be a second thing to tune and a second thing
to disagree.

## Why the alternatives lost

- **Break the composition — write a park `recipe unpark` does not clear.** The other arm the
  governance verdict offered. It keeps 0373 untouched by making the park route to a human, which is
  the hand step this ticket exists to delete: a lane would move from "sits in `build` until somebody
  looks" to "sits in `blocked` until somebody looks", at the cost of a board read per building lane.
- **Let the sweep retract the claim itself.** One verb instead of two, and it revives the shape 0215
  §5 and #5752 refused outright. The split read is what keeps a reader from ever writing, and
  `claimStanding` exists as a pure predicate precisely so the reader and the writer cannot come to
  mean different things by dead.
- **A 30-minute floor behind its own config key.** Priced above: an unclearable park for the gap
  between the two numbers, and a second horizon to tune against the first.
- **Narrow the sweep to the plain `build` leaf on a single lane.** Cheaper, and it strands exactly
  the lanes a rendered-surface builder and an epic child leave behind — the same five-day seat, on a
  population nobody would be watching.

## Consequences

- **A live builder at minute 41 can still lose its claim, and the bound is narrower than 0373's.**
  0373 priced a builder still working past its budget inside a park a driver recorded. Here that
  builder must also have cut no branch and published nothing — 41 minutes into a loop whose fourth
  step is `build branch`. Not impossible: a builder stopped and resumed, or blocked on a long read,
  sits there. The outcome is 0373's unchanged — the ordinary earliest-authorized tiebreak, the
  evicted shell's own next `build confirm` refusing, never a double-implement — and widening the
  build budget is the fix, in the weekly machinery review.
- Conjunct 2 is clone-scoped, and that is a real limit: an epic child publishes only onto its lane
  branch, so a sweep run from a clone that did not spawn the builder reads its work as absent. It is
  the same containment `clearSpawnClear` already depends on and does not enforce.
- 0373's `status:` line records this amendment; its body is untouched, per the accepted-ADR
  immutability rule.
- [`shell-budget.ts`](../packages/fabrika-cli/src/lane/shell-budget.ts) and
  [`unpark-verb.ts`](../packages/fabrika-cli/src/recipe/unpark-verb.ts) both asserted the confinement
  this record lifts — "the one caller", "confined to this row" — and both are corrected to name two
  callers and the one that may only read.
- [`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) names the chain rather than the
  half: the park this sweep records is the one `recipe unpark`'s `spawn-clear` row clears, and the
  claim ends there.
- The `.glossary` gains nothing. This record names no new noun; it moves one conjunct of a mechanic
  0373 already homed.
