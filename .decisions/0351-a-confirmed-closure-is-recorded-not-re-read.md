---
id: 0351
title: A confirmed closure is recorded, not re-read
status: accepted
date: 2026-09-04
---

# 0351 — A confirmed closure is recorded, not re-read

## Context

ADR [0350](0350-a-correction-supersedes-a-recorded-line.md) gave `lane reconcile` a way to repair a
lane whose ship `DONE` never recorded whether its merge closed the issue. It nominates a lane
offline — the latest recorded event that took a `merge:partial` cell's fallthrough carrying no
`partial` — and reads that one merge's closure off the board.

The nomination cannot tell the two answers apart before it asks. A merge that closed its issue
records no `partial` either, so it nominates exactly like a partial one. On phoenix's own ledger
that was 228 of the 298 guard-declaring lanes, at one serial pull-request read each. A real run
exhausted a GitHub rate limit part-way through and left seven lanes `unknown`, which reads as judged
when it is not, and `--check` costs the same reads, so there was no cheap dry run either. 0350's own
last Consequence names bounding this as open work it does not claim; [#7787](https://github.com/kamp-us/phoenix/issues/7787)
is that work.

The cost is not the sweep's size, it is that the sweep has no memory. Every pass buys the same
answer for the same lane again, because nothing the first pass learned was written down.

## Decision

Ruled by the founder in
[#7787](https://github.com/kamp-us/phoenix/issues/7787#issuecomment-5537533671). **A closure that has
been read is recorded, at both polarities, on the line whose closure it is.** Two halves, and the
second is what reaches the existing backlog:

1. **The ship stage writes `partial` at both polarities.** `lane prove` already computes the value;
   `lane report` dropped the `false`. It now records `partial: false` on a closing merge and
   `partial: true` on a partial one. `findMisroute` already skips a line at either polarity, so a
   lane shipped after this stops nominating with no further change.
2. **`lane reconcile` records the confirmed read.** On a nominated lane whose board read answers
   "closes", it appends a `<TASK>.CORRECTED` line carrying `partial: false` — the closing twin of the
   correction it already appends for a proven partial. That line supersedes the nomination and moves
   no task: an absent `partial` and a recorded `false` route the fold identically, so the lane still
   folds to `complete`. The next sweep skips it.

The backlog therefore costs one read per lane, once, rather than every sweep. A run that dies on a
rate limit resumes rather than restarts, because every lane it confirmed before dying stays
confirmed.

**Absent now means "nobody read the closure", not "the merge closed it".** The fold's reading is
unchanged — an absent `partial` still takes the closing arm, so every line written before ADR 0343
folds exactly as it did — but the ledger can now distinguish an unread closure from a read one, and
that distinction is the whole saving. `ProofOutcome.partial` carries it as `boolean | null` rather
than collapsing "no read ran" into `false`, so an event whose closure nobody read records no field
at all. Only the ship stage's `DONE` reads a closure, so only it carries one.

**No cache outside the ledger.** A per-lane judgement cached by the recorded line's `at` would reach
the same backlog, and it was rejected: the ledger is the record, and a second store of the same fact
is a second thing to invalidate. Batching the reads was rejected for reaching nothing — the same
population would still be read on every sweep, just faster. An operator-supplied lane filter was
rejected as the fix; it stays available as a mechanic for a one-time backfill run, and nothing here
builds one.

## Relationship to ADR 0350

**0350 rules that widening what a correction may touch is a decision rather than an extension**, and
this is that decision, taken narrowly. The field being widened is the one 0350 already made
corrigible — `partial` — and what widens is the polarity, not the field set. A correction still
supersedes only the routing payload of a line that sat on a `merge:partial` cell, and the constraint
0350's Consequence protects is untouched: no correction may rewrite a class or a wait grant, so no
sweep can re-route a round a lane has already walked past. A `partial: false` correction cannot
re-route anything at all — it names the arm the lane already took.

0350's last Consequence, which states the sweep's cost as hundreds of requests and names bounding it
as unclaimed work, is superseded by this record. Everything else in 0350 stands.

## Consequences

- A `confirmed` verdict joins `lane reconcile`'s vocabulary, paired with `closes` exactly as
  `corrected` is paired with `misrouted`: `closes` is the check-only row, `confirmed` the appended
  one. A confirmed row's `from` and `to` are equal, which is the row saying it moved no task.
- `--check` still costs a full sweep's reads and now buys nothing for the next one, since it
  withholds the very line that would make the next sweep cheap. It is a dry run, not a cheaper run,
  and says so.
- A repaired lane's log grows one line per never-confirmed ship. Nothing is rewritten; `lane history`
  prints the recorded line and its confirmation both.
- The first sweep over a pre-0351 ledger is still hundreds of reads. This record shrinks the
  recurring cost to zero for a confirmed lane, not the one-time backfill, and a backfill under a rate
  limit is still an operator's problem to pace.
- `lane report`'s stdout and its recorded line both carry `partial` at either polarity now, so a
  reader that treated the field's presence as "the merge was partial" is wrong. Nothing in the repo
  read it that way — the fold reads the value — but a future reader is warned here.

## Amendment 2026-09-04 — the `false` this record started writing was not a read

Decision half 1 above rests on "`lane prove` already computes the value", and that premise was
false. `lane prove` computed it through `nominatePulls`, which cannot see a merged `Part of #N` —
GitHub builds the closing edge from closing keywords and the search half pins `is:open` — so at the
ship stage, where the PR is always already merged, the read returned nothing and `traceClosure`
answered `Closes` by default ([#7457](https://github.com/kamp-us/phoenix/issues/7457)). This record
therefore taught the ship stage to write `partial: false` from a fallthrough rather than an answer,
and half 1's "a lane shipped after this stops nominating" stopped exactly the wrong lanes: a
partially-merged one recorded `false`, `findMisroute` skipped it, and the sweep that exists to catch
it never looked. Lane 7740 was the live instance.

Two things change and the rest of this record stands. **`lane prove` now reads the closure off the
PR the event names**, which is the read ADR 0350 already made off a recorded line, so both verbs
share one reader and the `false` a ship stage writes from here on is a real answer. **A read that
proved nothing is `unknown` and records no field at all**, which is this record's own "absent means
nobody read the closure" applied where it had been quietly violated — and it also means an unread
board no longer refuses the shipper's terminal, since leaving the field absent hands the line to the
next sweep instead.

Half 1's "`findMisroute` already skips a line at either polarity" is amended accordingly: it skips a
recorded `true`, and skips a `false` recorded once the ship stage began reading off the named PR,
but a `false` recorded between this record and that fix is nominated once.

**The two are told apart by what the line names, never by when it was written.** An answered read
now records the merged pull requests it stood on beside the polarity, as `landed`, so a `false` the
fixed stage wrote names its evidence and a `false` the old nominator fell through to names none.
Keying the skip on a wall-clock cutoff instead — the first shape this took — would have held only
while the fix's own merge beat the instant the constant guessed at, and the assumption was nowhere
enforced: every `DONE` the unfixed code recorded past that instant would have read as its own
answer, folding its lane to a terminal over an open issue with no sweep left to reach it. Keying on
the evidence keeps the saving this record bought — a lane shipped after the fix still costs zero
recurring reads — while the correction appended on that single re-read is what settles the line, at
either polarity, exactly as half 2 already specifies.
