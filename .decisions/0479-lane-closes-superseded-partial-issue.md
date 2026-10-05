---
id: 0479
title: The lane closes an issue a superseding ruling left delivered after a partial merge, never a person
status: accepted
date: 2026-10-05
tags: [fabrika, pipeline, lane, decisions]
---

# 0479 — The lane closes an issue a superseding ruling left delivered after a partial merge, never a person

**What this decides:** when a pull request merged as `Part of #N` and a later founder ruling drops
the last criterion it left unmet, the lane's next build round closes #N as completed and records the
lane as shipped, instead of ending `diagnosed` over an open issue.

Founder ruling, 2026-10-04, on [#10455](https://github.com/kamp-us/phoenix/issues/10455):
[the ruling comment](https://github.com/kamp-us/phoenix/issues/10455#issuecomment-5983096301).
The rulings desk asked: "Should the lane close it itself, once a second builder confirms every
remaining requirement is met on main?" He picked "Yes, the lane closes it" over "No, a person closes
it", and typed no note. This record transcribes that answer; the choice is not the author's.

## Context

A pull request can ship most of an issue as `Part of #N`. [ADR 0343](0343-a-partial-merge-sends-the-lane-round-again.md)
then sends the lane back to `queued`, because work remains. If the founder then drops the unmet
criterion with `fabrika decision rule <n> --supersedes <k>`, no work remains. The next builder finds
nothing to change and reports `SUCCESS-NO-PR`. The coder workflow's `done:diagnosis` arm folds that
to the `diagnosed` final, and `lane report` closes an issue only after a closing merge
(`issueCloser` in `packages/fabrika-cli/src/lane/report-verb.ts`). So the issue stays open, and
`lane settle` refuses to record a landing over a lane that already ended. Both
[#8622](https://github.com/kamp-us/phoenix/issues/8622) and
[#8064](https://github.com/kamp-us/phoenix/issues/8064) ended this way and were closed by hand.

#10455 put four options: the lane closes it, the ruling command closes it, a person closes it, or the
cost is accepted and nothing is built.

## Decision

**When a build round reports `SUCCESS-NO-PR` on a lane whose `Part of` merge already landed and whose
remaining criterion a later ruling superseded, `lane report` closes the issue as completed and the
lane records `shipped`, not `diagnosed`.**

**The evidence the closer reads.** All three facts must hold, each read, never assumed:

1. The lane's own log holds a ship-stage `DONE` recording `partial: true`: a merged pull request that
   reached the issue through `Part of #N` and left it open, as 0343 records it.
2. The issue carries a current `decision-ruled` marker with a `supersedes:` field, dated after that
   merge. That field is the one mechanical statement that a ruling dropped a criterion
   (`packages/fabrika-cli/src/wire/decision-ruling.ts`).
3. The second builder graded every criterion still in force as met on main and reported
   `SUCCESS-NO-PR`, proven the way the no-PR arm already proves it: off the `build note` it posted.

When all three hold, the closer posts a comment naming the merged `Part of` pull request and closes
the issue as completed, the same act `issueCloser` takes after a closing merge. When any fact is
missing, `SUCCESS-NO-PR` folds to `diagnosed` exactly as today and closes nothing. An unreadable fact
is UNKNOWN and never read as present.

**What the lane ledger records.** The closing event's line names the merged pull request and the
superseding ruling as its evidence, and it folds the task to the `shipped` final, so the lane reads
`complete`. Shipped work reads as shipped. A `diagnosed` final stays reserved for a round that ended
on a diagnosis with nothing delivered.

**Why the other options were not taken.**

- **The ruling command closes it** was not on the desk, and the ruling names the lane as the closer.
  It would also need a read of which criteria the merged pull request left unmet, and #10455's
  triage did not find that recorded in a form a verb can read.
- **A person closes it** was the desk's other button, and the founder declined it.
- **Accept the cost** is the opposite of the ruling, which asks for the lane to close the issue.

**Binding constraints.**

- The close fires only on the three facts above. A `SUCCESS-NO-PR` with no `partial: true` merge in
  its own log, or with no superseding ruling after it, closes nothing.
- The builder decides nothing new. It grades the criteria that remain in force; a criterion it finds
  unmet means work remains, and the round builds it rather than reporting `SUCCESS-NO-PR`.
- Implementation is filed as [#10594](https://github.com/kamp-us/phoenix/issues/10594), with its own
  acceptance criteria. #10455 closes on this record alone.

**Not decided here.** The close rests on the no-PR proof, and that proof has an open bug:
[#10315](https://github.com/kamp-us/phoenix/issues/10315) accepts the builder's own claim marker as
evidence. Whether #10594 waits on #10315 is not in the ruling.

## Relationship to ADR 0343 and ADR 0443

[ADR 0343](0343-a-partial-merge-sends-the-lane-round-again.md) still sends a lane back to `queued` on
a `Part of` merge. This record does not amend it. It decides where that second round ends when a
ruling has since dropped the remaining work: closed and `shipped`, rather than `diagnosed` over an
open issue.

[ADR 0443](0443-amended-issue-regrade-triage-sweep.md) handles the neighbouring case, where a body
edit discharges the last criterion, with a read-only triage sweep for a person to re-grade. This
record does not amend it either. The two read different evidence: 0443 reads body edits after the
last ticked box, and this record reads a `supersedes:` ruling marker, which is a comment the sweep
never lists. 0443 left the lane ledger untouched. This record writes it, because here a lane is
already standing on the issue and has a round to end.

## Consequences

- A delivered issue closes in the round that confirms it, with no hand close and a lane record that
  reads `complete`.
- The second builder run is still spent. The ruling accepts that cost in exchange for the builder's
  grading on main.
- The close trusts the no-PR proof. Until #10315 is fixed, that proof is weaker than the closing
  merge proof, and a mistaken `SUCCESS-NO-PR` here closes an issue rather than only ending a lane.
