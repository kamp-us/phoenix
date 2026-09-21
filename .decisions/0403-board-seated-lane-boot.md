---
id: 0403
title: A stranded lane re-boots from what the board proves
status: accepted
date: 2026-09-21
tags: [lane, fabrika-cli, operate]
---

# 0403 — A stranded lane re-boots from what the board proves

**What this decides:** when a lane's ledger was written on another operator's machine and cannot be
produced, `lane open --from-board` boots a new one — admitted by the pull request's own current-head
verdicts, and seated with its repair budget declared spent.

## Context

Two operator accounts drive this board. A lane's ledger is its whole state, `.fabrika/` is
gitignored, and nothing replicates it, so a lane triaged, built and reviewed under one account
leaves a successor driver under the other with no ledger at all.

`lane open` refuses that re-boot at exit 63, and the refusal is right about what it guards: booting
a second ledger over a lane that already ran restores its spent repair budget with nothing recording
that a round was granted. What it had no arm for is a prior ledger that is unreachable **forever**.
The two escapes it named both need something this checkout does not have — `lane clear` needs a lane
directory, `build clear` grants a repair round on a pull request where nothing failed. So a driver
holding a green, twice-PASSed PR ended `STOPPED` with no verb that moved it, and the only moves left
were the two `operate` forbids: hand-merging outside the pipeline, or faking a ledger.

That was hit on lane 9426 / PR #9430 and filed as
[#9435](https://github.com/kamp-us/phoenix/issues/9435). #9428 is the same root cause from the other
side — a lanes root is per-working-tree while a lane is repository state.

The founder ruled it in
[this comment](https://github.com/kamp-us/phoenix/issues/9435#issuecomment-5752589286): a stranded
ticket whose change is approved and clean gets one named route to restart from what the board
proves, and the guard still refuses anything unproven.

## Decision

**A stranded lane re-boots only on what the board proves, and it mints no repair budget at all.**

`fabrika lane open <issue> --from-board` is the one route. The flag reaches the exit-63 refusal and
nothing else: every other boot behaves exactly as it did, and the flag can only widen the one
refusal it is for.

Admission is a read, never the caller's assertion. The board must show exactly one pull request
hanging off the issue, open, with every namespace its head derives answered — the same
`foldNamespaces` fold `lane prove` takes for a `PASS`, over the same `readNamespaceRows` read, so the
bar this boot clears is the bar the `PASS` it stands in for would have had to. Anything short of it
is exit 63 again carrying the board's own reason: a standing `FAIL`, a verdict that no longer binds
the head, several pull requests, a merged or closed one. A read that failed is exit 11 — UNKNOWN,
never a seat.

The placed document declares `maxRetries: 0`. The board proves the work is verified; it proves
nothing about how many repair rounds the prior lane burned, so this boot derives no budget rather
than a plausible one. A `FAIL` on such a lane parks at `human:budget-spent` at once, and a round
comes back the way it always did — `lane clear`, which records the grant on the lane's own log and
raises the budget by exactly the round it records.

The adoption is recorded as a comment on the issue **before** anything lands on disk. A seat nobody
can review afterwards is the laundering this refusal exists to stop, whatever admitted it.

The lane is placed at its initial state, not at a stage. Walking it forward is `lane transition`'s,
and that verb proves every event against the board before it records one, so the seat never asserts
a stage the board would not re-prove.

### Alternatives rejected

- **Succession over the ledger, in parity with `lane adopt`.** `lane adopt` succeeds a dead *claim*,
  which is a marker on the board; a ledger is local bytes nobody else can attest to. An attestation
  that a prior ledger is spent would be a driver asserting the one fact no read can reach, which is
  precisely what the guard refuses.
- **Do nothing and route each case to a founder cycle.** Rejected by the ruling, and by the failure
  mode: a guard that leaves finished work unreachable pushes drivers toward hand-merging.
- **Seat the lane directly at `ship` by appending derived events at boot.** Rejected as a second
  copy of the proof path. `lane transition` already proves each event against the board and refuses
  an unproven one; a boot that appended its own events would have to re-implement that gate, and a
  future divergence between the two would be invisible.
- **Carry the prior lane's budget forward at its declared full value.** Rejected as the laundering
  itself, in a politer shape.

## Consequences

A cross-operator handoff now costs one flag instead of a founder cycle, and it leaves a comment on
the issue that names the pull request and head it was admitted on, so the succession is reviewable
after the fact.

A board-seated lane has no repair budget, so the first `FAIL` on it parks for a person even when the
prior lane had rounds left. That is the deliberate trade: the unprovable half is charged to the
driver, not to the guard.

The admission costs board reads — the pull request, its changed files, its comments, the issue's
standing rulings — and they are paid only on a boot that would otherwise have refused.
