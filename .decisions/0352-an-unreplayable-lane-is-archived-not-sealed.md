---
id: 0352
title: An unreplayable lane is archived, not sealed
status: accepted
date: 2026-09-04
---

# 0352 — An unreplayable lane is archived, not sealed

## Context

Eight lane ledgers under `.fabrika/lanes` carry events their own machine cannot replay. Five (5991,
6005, 6037, 6100, 6462) hold an `ISSUE.DONE` appended after the fold had already reached `frozen`;
three (6226, 6374, 6759) hold an `ISSUE.PASS` while the machine reads `build`. Every one shipped in
August 2026 and every issue is closed.

`frozen` is a `final` state in both committed templates and its only cell is `PARK_SWEEP.UNBLOCKED`,
so `foldLog` fails and `lane reconcile` classifies the lane `unreadable`; `lane migrate` refuses the
same eight through `judgeMigration`'s `Unreplayable` verdict. They are noise on every sweep and
nothing in the pipeline can clear them, because the fault is in an append-only log neither verb may
rewrite. The cost is eight rows a run; the risk is that a genuinely broken lane later hides among
them.

Two routes were named on [#7803](https://github.com/kamp-us/phoenix/issues/7803) and neither was
ruled: seal each lane with a closing line so its log replays again, or move it out of the swept
roots. They are opposite in what they treat the ledger as — a record that may be repaired, versus
one that is closed and set aside — so the choice was a ruling, not an implementation detail.

## Decision

**A lane whose log will never replay leaves the sweep's scope by moving, never by a line appended to
its log and never by widening the machine.** Ruled by the founder in
[#7803's ruling comment](https://github.com/kamp-us/phoenix/issues/7803#issuecomment-5544645381).

`fabrika lane archive <lane>` moves one lane directory from the lanes root to an archived root
(`.fabrika/lanes-archived`). It refuses, non-zero and with the directory where it was, unless **both**
hold:

- the lane's issue reads **closed** on the board (exit `49` when it is open), and
- the log **does not replay**, judged by the same `judgeMigration` that `lane migrate` makes — through
  the lane's own machine or through the committed template (exit `50` when it replays).

The judgement runs before the board read, because it is local and free. An unreadable board, an
unreadable template, or a machine no candidate can be built for is UNKNOWN at exit `11` and moves
nothing.

The archived root is a **sibling** of the lanes root, never a directory under it. `lane reconcile`
and `lane migrate` sweep the roots they are handed, and neither is ever handed this one — so no sweep
learns a skip rule it could get wrong. The record stays readable: `lane history` and `lane brief`
take `--root`, so an archived lane is read by pointing them at the archived root.

Only an issue lane is archivable. A chore lane drives no issue, so the closed-issue gate can never
hold for one, and the verb refuses it at exit `19` rather than pretending otherwise.

## Rejected

**A sealing line** — a `CORRECTED`-shaped or new `SEALED` event appended to a terminal lane whose
issue is closed, so the log replays again. Rejected: it writes a line describing history that did not
happen, which is exactly what ADR [0350](0350-a-correction-supersedes-a-recorded-line.md) governs. A
correction supersedes a line that *was* recorded; there is no recorded line here to supersede.

**A `frozen` → `DONE` cell** — give the final state the update cell the appended events want.
Rejected: `frozen` is where a lane lands at its retry cap, and the cell would let such a lane ship
without the `UNBLOCKED` that cap exists to force. That is the guard, not an oversight
(ADR [0313](0313-a-queue-dwell-is-a-wait-not-a-park.md)).

## Consequences

- The eight lanes leave both sweeps, and a later lane in the same state does too — one call each, no
  hand-editing of an append-only log anywhere.
- A genuinely broken lane still shows up on every sweep, because both gates must hold. An open issue
  or a replaying log is refused, so an archive can never quietly hide live work.
- The archived ledger is out of every sweep, which means nothing watches it. That is the point, and
  it is why the closed-issue gate is not negotiable.
- `lane migrate`'s unsafe refusal now names `lane archive` as the route for a closed, unreplayable
  lane, in place of "decide each unsafe lane's state by hand".
- Two exit codes are added to the lane table: `49` the issue is open, `50` the log replays.
