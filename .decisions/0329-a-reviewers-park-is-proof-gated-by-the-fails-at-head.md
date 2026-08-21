---
id: 0329
title: A reviewer's park is proof-gated by the FAILs at head
status: accepted
date: 2026-08-21
tags: [fabrika, lane, pipeline, review, state-machine]
---

# 0329 — A reviewer's park is proof-gated by the FAILs at head

**What this decides:** a reviewer picks its terminal once, at the end of its run, and `lane prove`
now reads a reviewer's park the way it reads a `PASS` — refusing it when the PR holds a `FAIL` that
still binds at the head, and recording it on every other reading. The `blocked` state gains no
`ISSUE.FAIL` cell.

## Context

Lane 5661's reviewer hit a malformed acceptance-criteria heading, treated that as its terminal, and
reported `UNKNOWN` at 19:54:12. `lane report` maps `UNKNOWN` to `ISSUE.BLOCKED`, so the lane folded
from `review` to `blocked`. The run then kept working — governance is derived-required every round
(ADR [0293](0293-governance-fires-every-round.md)) — and landed three FAIL verdicts current at head
`2c8a83fb`. Recording the real terminal refused: exit `12`,
`no update cell for msg.type "FAIL" in state "blocked"`. The log is append-only, so nothing
corrected in place, and the ledger read a wait on a human over a PR that needed a repair round
(#6112).

Two routes out differ in a way nothing downstream can detect. `blocked` clears only by a human
`ISSUE.UNBLOCKED`; a failed review routes into a repair build under the retry budget. So a review
that reached a dispatchable verdict became one that waits on a person, and on lane 5661 the wait
looked right — the heading did need a human — which is what made the stranded FAIL underneath it
invisible.

## Decision

**The reviewer holds its terminal.** An input it cannot read is one input to the verdict it reaches
at the end, never an exit from the run. One `lane report` call per run, made once every namespace
the PR derives is terminal. The rule the reviewer skill already carried was FAIL-only ("record a
FAIL only when every derived namespace holds a verdict that still binds"); it now has a second arm
covering `UNKNOWN`, `STALE` and `UNBINDABLE` — record one only when no derived namespace holds a
still-binding `FAIL`.

**`lane prove` enforces the half a read can decide.** A `BLOCKED` out of `review` or `review:ui` on
a lane that owns a PR is a third claim beside `DONE`-out-of-`build` and `PASS`-out-of-`review`, and
it is the one negative claim of the three: it asserts the run reached no verdict. `foldPark` refuses
it on a still-binding `FAIL` (exit `24`, naming the namespaces and pointing at `FAIL` as the token
to record) and proves it on every other reading — absent, stale, passing, or a board that could not
be read at all.

**Fail-open is the right polarity here, and only here.** A park routes to a human, the shell
reporting it has already stopped, and there is no later round to re-read in, so holding a park on an
unreadable board would strand the lane in the one state nobody could leave. The claim it refuses is
narrow by construction: a run that posted a dispatchable FAIL and recorded a park anyway.

## Alternatives

**A `blocked` `ISSUE.FAIL` cell** — the machine-side fix, the shape #5807 added to `ship`. Rejected:
a `FAIL` carries no proof out of `blocked` (`claimOf` answers `None` for it), so any lane's park
could be popped by any shell's FAIL — including a builder's back-off park, which is recorded for a
human precisely because no round can clear it. On lane 5661 the cell would also have spent a retry
on a repair round that must itself back off, since a build lane may not write an issue body. It
buys the ledger a correction at the cost of the park's meaning.

**A guard that refuses the early park itself.** Not buildable: at 19:54:12 no verdict existed, and
"has not judged yet" and "judged and could not read" are the same board. What is decidable is the
other order — a run that reached a verdict and then parked — which is exactly the order the
terminal-holding rule makes the only one.

## Consequences

- A reviewer's park is a board read now, where it used to be a free append. On an unreadable board
  it still records, so no park becomes unreachable.
- The refusal is the reviewer's remedy in one line: record `FAIL`.
- Neither fix alone closes every path — a shell that dies mid-run strands the lane whichever way —
  and that residue is unchanged here. `heal-ci`'s stranded-PR sweep is what finds it.
- An epic child's park is not read: a child opens no PR (ADR [0285](0285-epic-machine-ends-in-review.md)),
  and its range-scoped verdicts are a different arm. #6112's shape is a PR lane.
