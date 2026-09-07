---
id: 0365
title: A board-dropped lane ends in a recorded cancellation, not a deleted directory
status: accepted
date: 2026-09-07
---

# 0365 — A board-dropped lane ends in a recorded cancellation, not a deleted directory

## Context

A lane stays nonterminal after the issue it drives is closed `not_planned` or `duplicate`. None of
the operator's six events can end it truthfully: a `DONE` out of `build` is proven against an open
PR linking the issue ([`prove.ts`](../packages/fabrika-cli/src/lane/prove.ts)) and a dropped issue
has none, `BLOCKED` only parks, and `UNBLOCKED` resumes the work the board just dropped. The park
causes in [`report.ts`](../packages/fabrika-cli/src/lane/report.ts) ride `BLOCKED` alone and hold no
closure token, and `lane stale` reads liveness off the fold, which never sees an issue close.

So the ledger is owed forever and the only remedy is `rm -rf` on the lane directory, which erases the
append-only history rather than recording an outcome. Lane 5983 was hand-deleted that way on
2026-08-29 — the second hand-deletion that day — and the same shape follows every duplicate or
wontfix close over a booted lane.
[#7310](https://github.com/kamp-us/phoenix/issues/7310) named two routes and left them open: a
dedicated recorded terminal, or an `issue-closed` park cause feeding a retirement path.

The founder ruled on 2026-09-07, on the issue: **the dedicated recorded terminal**. Not a park cause,
because a park is a state something is waiting in and nobody is waiting here.

## Decision

**A board-proven `not_planned` or `duplicate` close ends its lane through a ninth event,
`<TASK>.CANCELLED`, appended by `fabrika lane cancel` and by nothing else.** The directory is never
deleted and no recorded line is ever rewritten.

Three things make it hold:

- **The cell is the compiler's, injected on every state**, the way `CLEARED` is
  ([`machine.ts`](../packages/fabrika-cli/src/lane/machine.ts)). `lane open` copies a template in at
  boot and never overwrites it, so a document-declared transition would reach no lane already on
  disk — and the lanes that need this terminal are exactly the ones already there. A document that
  declares the event, or a state named `cancelled`, is a compile defect.
- **`cancelled` is its own workflow terminal**, not folded into either declared one. `complete` would
  claim the work landed and `tripped` would claim it failed; the board said neither. `deriveStatus`
  reads it as `status: "done"`, so `lane status`, `lane stale`, `lane view` and `seatsIn` all read
  the lane terminal with no further change.
- **The board read is the whole entitlement**, because a cancellation is the one lane terminal with
  no artifact behind it. The issue's own `state_reason` decides: `not_planned`/`duplicate` entitles
  it, `completed` refuses at exit `52` and routes to the shipped path (`lane reconcile`, then
  `lane archive`), an open issue refuses at `49`, and an unreadable board or a close carrying no
  reason is UNKNOWN at `11` with the log unappended. The proven outcome is recorded on the line as
  `outcome`, so a later reader can audit the terminal; a `CANCELLED` line carrying none is a parse
  defect rather than an event.

Who records it: **the driver holding the lane**, per the
[`operate` skill](../claude-plugins/fabrika/skills/operate/SKILL.md). `triage kill` closes the issue
and touches no ledger, so the lane stays owed until the driver runs the verb. A live authorized lane
claim refuses at `31` unless the caller names that token, so a lane another session is driving is not
ended underneath it.

## Consequences

`DONE`'s proof semantics are untouched and a landed closure still goes through the shipped path, so
the two terminals cannot be confused. The operator's transition vocabulary stays at six: `CANCELLED`
is refused by `lane transition` with a message naming `lane cancel`, exactly as `CLEARED` and
`CORRECTED` are.

Every lane on disk gains the cell without migration, which is the property the injected-cell shape
was chosen for; a lane already carrying a terminal, or a task already in a final, is refused before
any board read.

An epic lane is not ended by one cancelled child: a phase holding a cancelled task beside an
unfinished sibling does not fold, so the lane reads `cancelled` only once that phase is done.
Whether an epic's whole run should be cancellable in one act is left open.

ADR [0352](0352-an-unreplayable-lane-is-archived-not-sealed.md)'s archive license is unchanged — it
covers a lane that is closed AND unreplayable, and this terminal covers a lane that replays fine and
has nowhere to go.
