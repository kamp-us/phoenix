---
id: 0365
title: A lane whose issue closed elsewhere ends in a recorded terminal, not a deleted directory
status: accepted
date: 2026-09-07
tags: [fabrika, lane, pipeline, state-machine]
---

# 0365 — A lane whose issue closed elsewhere ends in a recorded terminal, not a deleted directory

**Amends ADR [0322](0322-closed-issue-lanes-demote-at-read-time.md) in part.** 0322 ruled that a
lane whose issue closed elsewhere is demoted at read time and nothing is written, and it barred three
mechanisms by name: "No seventh operator event, no new terminal cell, no reconciliation verb." The
2026-09-07 founder ruling lifts the second and third. The first stands untouched — see below.

## Context

`.fabrika/lanes` holds 69 lane directories that `seatsIn`
([`concurrency.ts`](../packages/fabrika-cli/src/lane/concurrency.ts)) counts as active seats,
against a `laneConcurrencyCap` of 2, so `lane open` refuses every boot at exit 51. Their issues split
three ways: 49 CLOSED/COMPLETED — hand-shipped, the PR merged, the lane never reached `ship` — 7
CLOSED/NOT_PLANNED, and 13 still open.

None of the operator's six events can end the 56 closed ones truthfully. `DONE` out of `build` is
proven against an open PR linking the issue ([`prove.ts`](../packages/fabrika-cli/src/lane/prove.ts))
and neither shape has one — the dropped issue never had a PR, and the hand-shipped one's PR is
merged, not open. `BLOCKED` only parks. `UNBLOCKED` resumes work that is already over. The park
causes in [`report.ts`](../packages/fabrika-cli/src/lane/report.ts) ride `BLOCKED` alone and hold no
closure token, and `lane stale` reads liveness off the fold, which never sees an issue close.

Neither existing exit reaches them either. `lane reconcile --check` reports all 69 `current`: their
machines never reached a merge cell, so there is no recorded closure line to correct. `lane archive`
refuses them, because its gate is a log that will never replay and these replay fine.

So the ledger is owed forever and the only remedy is `rm -rf` on the lane directory, which erases the
append-only history instead of recording an outcome. Lane 5983 was hand-deleted that way on
2026-08-29 — the second hand-deletion that day — and
[#7310](https://github.com/kamp-us/phoenix/issues/7310) named two routes and left them open: a
dedicated recorded terminal, or an `issue-closed` park cause feeding a retirement path.

**What 0322 barred, and what the ruling lifts.** 0322 read the goal as presentation — a viewer band
— and barred the write side outright. Two of its three bars are lifted here, and the lift is the
founder's, recorded on #7310 on 2026-09-07:

- **"No new terminal cell" — lifted.** Two are minted below.
- **"No reconciliation verb" — lifted.** `lane settle` is one, and it is run rather than derived.
- **"No seventh operator event" — NOT lifted, and not needed.** `OPERATOR_EVENTS` still holds six.
  Both events below are refused by `lane transition` and by `applyEvent`, so ADR
  [0297](0297-frozen-is-a-park-not-an-end.md)'s binding constraint ("the six-event vocabulary is
  unchanged and closed") — itself the founder's own closure on
  [#5570](https://github.com/kamp-us/phoenix/issues/5570) — stands unamended. That constraint is what
  barred the mechanism 0322 was offered; the mechanism here sits outside it.

What the ruling rejects in 0322 is the reasoning that "being closed elsewhere is not something the
lane did", applied to the ledger's terminal. It is still true that the *board's* state is not the
lane's event. What 0322 missed is that the record of somebody having read the board and settled the
lane on it **is** something the lane did — and 0322's own read-time demotion never fixed the seat
count, which is what turned a presentation nuisance into a stopped pipeline. 0322's viewer band is
unaffected and still correct for the 13 open-issue lanes it also covers.

## Decision

**A board-proven closure ends its lane through one of two events appended by `fabrika lane settle`,
and by nothing else.** The directory is never deleted and no recorded line is ever rewritten.

| Board closure | Event | Terminal | Evidence on the line |
|---|---|---|---|
| `not_planned` / `duplicate` | `<TASK>.CANCELLED` | `board:cancelled` | `outcome` |
| `completed` **and** ≥1 merged PR linking the issue | `<TASK>.LANDED` | `board:landed` | `outcome`, `landed` (PR numbers), `sha` (merge commit) |

Everything else appends nothing. An open issue refuses at `49`. A read that failed, a close carrying
no `state_reason`, a reason outside the three, and a `completed` close naming no merged linking pull
request are all UNKNOWN at `11`. That last one is the load-bearing refusal: a board saying "done"
while naming nothing that did it is genuinely unread, and a `LANDED` line's whole job is to name the
merge it stands on.

Four things make it hold:

- **The cells are the compiler's, injected on every state**, the way `CLEARED` is
  ([`machine.ts`](../packages/fabrika-cli/src/lane/machine.ts)). `lane open` copies a template in at
  boot and never overwrites it, so a document-declared transition would reach no lane already on
  disk — and the lanes that need these terminals are exactly the ones already there. A document that
  declares either event, or either final's state name, is a compile defect.
- **The finals are namespaced `board:`**, which is load-bearing and not decoration: an emitted epic
  machine already owns a document state called `landed` (`emit.ts`'s `initialFor`, a child booted
  over a completed close), so an unprefixed name would refuse every epic lane in the repo. The prefix
  also says where the fact came from, which is the one thing separating these leaves from the ones a
  lane's own flow earns.
- **Each is its own workflow terminal**, not folded into a declared one. `complete` would claim this
  lane's own flow finished it and `tripped` would claim it failed; the board said neither.
  `deriveStatus` reads both as `status: "done"`, so `lane status`, `lane stale`, `lane view` and
  `seatsIn` read the lane terminal with no change of their own.
- **The board read is the whole entitlement**, because both terminals are proven from nothing on
  disk. The proven outcome and, on a landing, the merged pull requests and their merge commit are
  recorded on the line, so a later reader can audit the terminal; a line carrying none is a parse
  defect rather than an event.

Who records it: **the driver holding the lane**, per the
[`operate` skill](../claude-plugins/fabrika/skills/operate/SKILL.md). `triage kill` closes a
duplicate, a founder closes a wontfix, a human merges a PR by hand — none of them touches a ledger,
so the lane stays owed until the driver runs the verb. A live authorized lane claim refuses at `31`
unless the caller names that token, so a lane another session is driving is not ended underneath it.

## Consequences

`DONE`'s proof semantics are untouched: neither event is `DONE`, neither is an operator event, and a
lane whose own flow really does reach `ship` still folds to `shipped` through the machine it always
did. A landing settled here is a lane the pipeline did NOT drive, and its terminal says so by name.

Every lane on disk gains both cells without migration, which is the property the injected-cell shape
was chosen for. A lane already carrying a terminal, or a task already in a final, is refused before
any board read.

An epic lane is not ended by one settled child: a phase holding a settled task beside an unfinished
sibling does not fold, so the lane reads its board terminal only once that phase is done. Whether an
epic's whole run should be settleable in one act is left open.

ADR [0352](0352-an-unreplayable-lane-is-archived-not-sealed.md)'s archive license is unchanged — it
covers a lane that is closed AND unreplayable, and these terminals cover a lane that replays fine and
has nowhere to go. The two are complementary and neither widens the other.

ADR [0350](0350-a-correction-supersedes-a-recorded-line.md) is untouched for the same reason: a
`CORRECTED` line amends a routing payload an earlier line got wrong, and a settlement records an
outcome no line ever carried. `lane reconcile` and `lane settle` reach disjoint populations — a lane
`reconcile` nominates recorded a merge closure, and a lane `settle` ends never recorded one.

## Amendments

**2026-09-08 — a caller may supply the link, and never the merge.** The first sweep under this verb
refused 17 of the seats at `11`: the issue closed `completed`, the work merged, and the merged pull
request's body cited some other issue, because a human closed this one by hand. The landing was real
and the board named nothing that did it, which is exactly the refusal above — and the refusal was
also the only way out of the cap, so those seats stayed held
([#8535](https://github.com/kamp-us/phoenix/issues/8535)).

`fabrika lane settle <lane> --landed-by <pr>` adds a second landing arm, and the split it makes is
between the *link* and the *merge*. The merge stays the board's: the named pull request must read
merged there, so an unmerged one refuses at `23`, one the repository does not hold at `22`, and an
unreadable read stays UNKNOWN at `11`. What the caller supplies is the one fact no read can recover —
that THIS merge discharged THIS lane — and the line records that they supplied it, as
`assertedBy: "caller"` beside the `landed` and `sha` a body-proven landing already carries. A
body-proven landing is judged first and wins, so the flag can only ever fill a gap and can never
relabel a link the board proved; and because the field is present only on an asserted line, every
line already recorded stays true unread.

This does not widen "the board read is the whole entitlement" so much as name its edge. The closure,
the merge and the seat are all still read off the board and refused where a read fails. Only the
attribution moves, and it moves onto the record rather than into silence — which is the same reason
the outcome is on the line at all: a terminal a later reader cannot audit is the thing this ADR
exists to prevent, and an asserted link that did not say it was asserted would be exactly that.
