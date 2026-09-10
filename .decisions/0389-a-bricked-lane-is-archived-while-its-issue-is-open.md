---
id: 0389
title: A bricked lane is archived while its issue is open, and its claim goes with it
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline]
---

# 0389 — A bricked lane is archived while its issue is open, and its claim goes with it

**What this decides:** `lane archive` no longer requires the lane's issue to read closed, and it
retracts the issue's live `lane-claim` marker as part of the move.

## Context

A lane whose `events.jsonl` carries an event its machine has no update cell for is unreadable by
every lane verb: they all replay the whole log first, so `lane prove`, `lane report` and `lane
status` refuse at exit `4`. The log is append-only, so there is no in-band correction either —
appending needs the replay that is broken.

ADR [0352](0352-an-unreplayable-lane-is-archived-not-sealed.md) built the route out and ruled its
shape: move the record aside, never rewrite it. But it gated the move on **two** facts, and the
second one closed the route for exactly the lane that needs it most:

- the log does not replay (exit `50` when it does), and
- the lane's issue reads **closed** on the board (exit `49` when it is open).

Lane 8810 hit that gap on 2026-09-10. Its epic was open, so the archive refused; `lane settle` needs
a board closure too; and repair needs the replay that is broken. Four current PASS verdicts and a
tail FAIL could not reach the ledger, and a second child's `BUILT-NO-PR` and a third's PASS were
refused the same way — the brick is per-lane, not per-task, because every verb replays the whole log
([#8922](https://github.com/kamp-us/phoenix/issues/8922)).

It is not one lane. A `lane open 8201` on the same day refused at exit `51` with eleven seats
standing against a cap of two, nine of them bricked ledgers:
`packages/fabrika-cli/src/lane/concurrency.ts` counts a lane whose log will not fold as an
`unaccountable` seat, so a bricked ledger holds a seat with no driver behind it. With no archive
route, the only remedy was deleting the lane directory — the exact act ADR
[0384](0384-a-retired-lane-does-not-re-open-over-its-own-work.md) closed off, and the thing an
append-only log exists to prevent.

## Decision

The founder ruled it on 2026-09-10
([the ruling comment](https://github.com/kamp-us/phoenix/issues/8922#issuecomment-5625310849)):
relax the closed-issue gate.

### 1. The unreplayable log is the whole entitlement

`lane archive` refuses a log that replays (`50`) and moves everything else. The lane's issue state is
neither read nor judged.

0352 kept the closed-issue gate because "an archived lane is beyond every sweep, and a live one
belongs where the sweeps can see it" — the fear being an archive that quietly hides live work. The
replay judgement already carries that: **a log no machine can fold is a lane nobody can drive.** Every
verb refuses it at exit `4`, so there is no live work to hide — only a dead directory holding a cap
seat and a claim. The gate was protecting against a state the other gate makes unreachable.

The open-issue arm is not a weaker archive. It is the *only* archive that ever mattered for a live
brick, and the closed-issue arm was always the easy case.

### 2. The claim dies with the lane, and the verb kills it

A lane that leaves the swept root while its issue carries a live `lane-claim` marker strands the
issue: the next `lane claim` reads a foreign holder on a lane that is no longer there. So the archive
retracts the marker itself — every `lane-claim` comment carrying the holder's token, plus any
`lane-adopt` marker naming the holder's session, since an adopt exists only to make one claim
releasable and does not outlive it.

**A claim the caller does not name is refused, not swept.** `--token` names it, exactly as `lane
settle` already demands, and a dead seat's claim goes through `lane adopt` first. Sweeping another
driver's marker is the one write the claim protocol must never make
(`packages/fabrika-cli/src/lane/claim-verb.ts`), and being about to delete a lane does not buy a
verb that permission. Exit `31` `CLAIM_NOT_MINE`.

**Retraction runs before the move.** The two failure orders are not symmetric: a retraction that
lands over a move that does not leaves an unclaimed lane where it was, which the next run archives;
the reverse leaves a claim on a lane nothing can release. A marker that will not delete is exit `8`
with nothing moved.

### 3. The lane re-lanes through the boot gates, and nothing new

After the move the issue is claimable and `.fabrika/lanes/<n>` is absent, so `lane open <n>` decides
whether it re-lanes — including ADR 0384's `63` `PRIOR_LANE` refusal when the board already hangs a
closing pull request off the issue. No re-open rule is added here, and none is relaxed.

### 4. A chore lane becomes archivable

0352 refused a chore key at exit `19` on the ground that "a chore lane can never satisfy the
closed-issue gate". With that gate gone the refusal has no ground left, and a bricked chore ledger is
the same defect. A chore key names no issue, so there is no claim thread and nothing to retract.

## Rejected

**A separate quarantine verb** for a live bricked lane, distinct from archive's done-and-dusted
semantics — the second named alternative on #8922. Rejected: it is the same act on the same
directory with the same "never rewrite" law, and a second mover would need its own root, its own
sweep exclusion and its own read-back path. Two verbs one fact apart is how the sweeps and the mover
come to disagree, which is the argument `archive.ts` already makes for calling `judgeMigration`
rather than re-deriving it.

**Leaving the claim to the operator** — refuse the archive while any claim stands, and say so.
Rejected: it makes the standing claim a second gate on the route that exists because there was no
route, and the nine dead seats on #8922 are exactly the case where nobody is left to release one.
The verb decides; `--token` and `lane adopt` are the two ways a *live* driver stays protected.

## Consequences

- A bricked ledger has one shipped route out at any point in its issue's life, and it frees the
  `laneConcurrencyCap` seat the moment it runs. `lane open` becomes reachable again without a human
  running nine archives by hand.
- Exit `49` `ISSUE_LIVE` is now `lane settle`'s alone. It stays in the table with its meaning
  unchanged; only `lane archive` stopped answering there.
- Exit `19` `ISSUE_UNRESOLVED` leaves `lane archive`'s table with the gate that produced it.
- `lane archive` gains `--token` and a board write. It was a read-and-move verb; it now retracts up
  to a handful of comments before moving, and a failed retraction is a refusal, never a silent move.
- An archived lane's issue reads unclaimed even where the board still shows the work in flight. That
  is the point — the lane is gone, so a claim naming it is a lie — but a driver reading the issue
  alone sees no trace of the archived lane, and the archived ledger is the only record of it.
