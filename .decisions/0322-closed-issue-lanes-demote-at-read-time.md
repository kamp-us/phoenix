---
id: 0322
title: A lane whose issue closed elsewhere is demoted at read time, not reconciled on disk
status: accepted
date: 2026-08-21
tags: [fabrika, lane, pipeline, viewer, state-machine]
---

# 0322 — A lane whose issue closed elsewhere is demoted at read time, not reconciled on disk

**What this decides:** nothing new is written to a lane whose issue was closed outside the lane's own
flow. `lane view` cross-checks the board when it renders and buckets such a lane into a "finished
elsewhere" band, away from the needs-a-person band. No seventh operator event, no new terminal cell,
no reconciliation verb.

Founder ruling,
[2026-08-20](https://github.com/kamp-us/phoenix/issues/6603#issuecomment-5361711214) — shape 3 of the
three put to him on [#6603](https://github.com/kamp-us/phoenix/issues/6603), verbatim "3". It
restates his direction earlier that day
([2026-08-20](https://github.com/kamp-us/phoenix/issues/6603#issuecomment-5359348420)): reconcile
rather than delete, keep `events.jsonl` on disk, make the rows reflect reality. This ADR transcribes
that ruling; the choice is the founder's, not this record's.

## The problem

The lane viewer sorts by what needs a person first. On 2026-08-20, nine of the first ten rows reading
"issue is waiting on a human" were for issues already closed on the board, most of them shipped days
before. The one genuine park, 5648, sat at position ten.

A reconciliation pass under the reconcile-don't-delete direction cleared 5937 with legal events and
found six lanes — 5845, 5851, 5877, 5866, 6282, 6452 — that no legal event sequence can move. Each
sits in `blocked` for an issue closed without a branch or a PR. The only exit from `blocked` is
`UNBLOCKED` to `queued`, whose only exits are `WIP` and `BLOCKED`; every remaining route to a
terminal cell runs through a build `DONE` plus a review `PASS`/`FAIL` naming a PR that never existed,
which `lane prove` refuses.

The mechanism that pass proposed — a seventh operator event — collides with ADR
[0297](0297-frozen-is-a-park-not-an-end.md)'s binding constraint that "the six-event vocabulary is
unchanged and closed", itself the founder's own closure on
[#5570](https://github.com/kamp-us/phoenix/issues/5570). So the goal was ruled and the only named
mechanism was barred.

## The decision

**The ledger records what the lane itself did, and being closed elsewhere is not something the lane
did.** Board state is a fact about the issue, read at the moment someone looks, never an event
appended to `events.jsonl`.

- **The vocabulary stays closed.** `OPERATOR_EVENTS` keeps its six members and ADR 0297's binding
  constraint stands unamended. This record supersedes nothing.
- **The fold learns nothing.** `events.jsonl` stays the fold's only input, so a closed-issue lane
  keeps folding to exactly the cell its own events earn — `blocked` for the six above. The board read
  is the viewer's, not the machine's, and it happens after the fold rather than inside it.
- **No terminal cell is minted.** There is no `abandoned`, and `frozen` is not repurposed. The
  question "what is the terminal cell called" has no answer under this shape, which is the point:
  the lane's state is unchanged and only its presentation moves.
- **`lane view` renders it as finished elsewhere.** A lane whose issue is CLOSED is bucketed into a
  "finished elsewhere" band and ranks below every row that needs a person. Its ledger is intact and
  still readable; it just stops competing with real parks for the top of the screen.
- **Reconciliation is a derivation on read, not a verb someone runs.** Nothing is written, so there
  is nothing to run and nothing to schedule. Closing the issue is the whole act; the next render
  tells the truth.

**The six named lanes are covered by this and need no further action.** 5845, 5851, 5877, 5866, 6282
and 6452 stay in `blocked` with their logs byte-identical, and drop out of the needs-a-person band
the first time the bucket ships. 5648 stays where it is — it is open, and it is the one true park.

## Where the work lands

The derivation and the sort are `@demlik/tea/chart/lane/server`'s. `lane view` supplies only the
facts fabrika knows — the root, the event origins, the transition callback, the port — so the bucket
itself is a demlik change, tracked on that repo.

Phoenix owes the input: per-lane board state passed alongside the existing four. The reader exists —
`getIssue(repo, issue)` in [`packages/fabrika-cli/src/io/issues.ts`](../packages/fabrika-cli/src/io/issues.ts)
returns an `IssueRecord` carrying `state` — so this is wiring, not a new client. It is also the first
board read in the lane group: nothing under `packages/fabrika-cli/src/lane/` reads issue state today.
That makes an unreachable board a real case, and the honest reading of one is that a lane's bucket is
UNKNOWN — it stays where its fold puts it rather than being demoted on a failed read.

## Consequences

A `blocked` row no longer means a person is owed. Anything reading the viewer's ordering as "these
all need me" has to read the band as well, and anything reading `events.jsonl` alone still sees six
lanes parked forever — correctly, because that is what the lanes did.

The cost the founder accepted is that the ledger and the board can disagree on disk. The reply is
that they were never the same claim: the ledger is the lane's own history, and a lane does not get to
record work it never performed just to look tidy.

## Records

No vocabulary impact. "Finished elsewhere" is a band in the viewer's presentation, not a lane state,
and the lane states are unchanged.
