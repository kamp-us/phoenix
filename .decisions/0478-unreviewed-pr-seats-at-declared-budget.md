---
id: 0478
title: An open pull request no review has touched seats a lane at its declared repair budget, never at zero
status: accepted
date: 2026-10-05
tags: [lane, fabrika-cli, operate]
---

# 0478 — An open pull request no review has touched seats a lane at its declared repair budget, never at zero

**What this decides:** `lane open --from-board` also boots a lane on an open pull request that nobody
has reviewed yet, and that lane keeps the repair rounds its template declares.

## Context

[ADR 0403](0403-board-seated-lane-boot.md) gave the exit-63 refusal of `lane open` one arm,
`--from-board`, for a lane whose ledger was written on another operator's machine. It admits only a
verified pull request, and it seats the lane with `maxRetries: 0`, because the board cannot say how
many repair rounds the lost ledger spent.

A pull request a builder opened outside any lane hits the same refusal, and 0403's arm did not fit
it. Nobody had reviewed it, so the fold read it as in flight and refused at 63 again. The only way in
was to run the review by hand with no lane, then boot at a zero budget, so the review ran outside the
lane and the first FAIL parked on a person. That was reported on
[#10321](https://github.com/kamp-us/phoenix/issues/10321).

The founder ruled it in
[this comment](https://github.com/kamp-us/phoenix/issues/10321#issuecomment-5974129700): a lane can
start on an open pull request that nobody has reviewed yet, with its normal repair rounds.

## Decision

**`--from-board` admits a second seat: an open pull request with no review on it at all, placed at
the repair budget its template declares.**

Admission is still a read of the board, never a flag or the caller's word. The board must show
exactly one pull request hanging off the issue, open, and no comment on it may read as any of the
three carriers a verdict travels in: a verdict marker, a routed-elsewhere record or a control-plane
advisory. That holds in every namespace and at every head, so a stale verdict counts, and a carrier
that drifted counts too. A pull request with no such comment has no FAIL marker, so `roundsOn` over
its comments is zero. Only a content FAIL spends the budget
([ADR 0377](0377-machinery-lap-narrows-repair-budget.md)), so there is no spent round to charge.

A pull request carrying any trace of a review keeps 0403's rule unchanged: admitted only when every
namespace its head derives has answered, at a zero budget, and refused at 63 otherwise. Several pull
requests, or a merged or closed one, still refuse at 63. A read that fails is exit 11, never a seat.

The adoption comment still lands on the issue before anything is written to disk. For this seat it
names the pull request and head, says no verdict was found, and says the lane carries its declared
budget. It never reuses the zero-budget wording.

0403's placement rule holds for this seat too. The lane is placed at its initial state and the boot
appends no events; `lane transition` walks it forward on the board's proof.

**This amends ADR [0403](0403-board-seated-lane-boot.md) in one clause.** 0403 says the seat it admits
is a verified pull request and that the placed document declares `maxRetries: 0`. That stays true for
a pull request a review has touched. For one no review has touched, the seat is the second one above
and the document is the template as it stands.

### Alternatives rejected

- **A flag that lets a driver say the pull request is unreviewed.** Rejected: the flag would assert
  the one fact the guard exists to read, which is the override shape
  [ADR 0384](0384-a-retired-lane-does-not-re-open-over-its-own-work.md) closed.
- **Seat it at the review step by appending events at boot.** Rejected for the reason 0403 gives: a
  second copy of the proof path `lane transition` already owns.
- **Read only the head's required namespaces.** Rejected: a verdict at an older head, or in a
  namespace the head no longer derives, is still a review someone ran, and how many rounds it cost is
  what no read here can prove.

## Consequences

A pull request opened outside a lane enters one with one command, and its review and repair rounds
run inside that lane.

The board cannot tell "never reviewed" from "reviewed, then the verdict comment was deleted". A
deleted verdict leaves no trace, so such a pull request would seat at a full budget. The cap that
`build verdicts` enforces rests on the same trust in the comment record.

The read costs one more comment page on a `--from-board` boot, paid only where the refusal would
otherwise fire.
