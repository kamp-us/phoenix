---
id: 0343
title: A partial merge sends the lane round again
status: accepted
date: 2026-09-01
---

# A partial merge sends the lane round again

## Context

A merged `Part of #N` pull request drove its lane to the `complete` terminal exactly as a merged
`Fixes #N` one did. The lane machine read no closing keyword anywhere, so the ship stage could not
tell a discharged issue from a deliberately partial one.

That is not a hole in the review gate. `build`'s step 5 already contracts `Fixes #<n>` only when
every acceptance criterion is met and `Part of #<n>` plus `--partial` otherwise, and `review`'s
`BOTH-ISSUE-KINDS-BIND` anchor already rules that an unmet criterion on a `part-of` PR is a fact the
verdict names rather than a FAIL. `lane/nominate.ts` already distinguishes the two kinds through
`issueRefsOf`. Only the ledger never learned the distinction the nominator was already drawing.

The cost is a lane whose ledger says finished sitting over an issue the board still calls buildable.
Live on #6980: `lane status` read `complete`, `build eligible` read `eligible`, and an operator
dispatched on it parked on `LANE-TERMINAL` — the pool and the drive loop giving opposite answers
about one issue, with no door out of the terminal for either to walk.

## Decision

**A merged PR that carried `Part of #N` sends its lane back to `queued` instead of folding it to
`shipped`.** Three pieces, each seated where the fact it needs already lives:

1. `nominate.ts` carries `issueRefsOf`'s `kind` beside its numbers as `PullFact.linkKind`. It was
   being computed and dropped; nothing new is read, and there is still one nominator.
2. `lane prove` reads the closure at the ship stage and relays it as `partial` on its outcome, the
   way it already relays `deferred`. It is a **routing** fact, not a proof: a `DONE` out of `ship`
   still claims no artifact, so this read refuses nothing about the merge. It refuses only being
   unable to *read* — an unread board is UNKNOWN, and the permissive reading is the exact fold this
   change exists to stop.
3. The compiler reads a second guard spelling, `merge:partial`, alongside `class:<name>`. It spends
   neither budget: a landed `Part of #N` is real work, not a repair round and not a wait.

`Partial` is taken on positive evidence alone — a merged PR reaching the issue through `Part of #N`
and through no closing keyword. A closing merge, merges linking elsewhere, and nothing nominated all
answer `Closes`, which is byte-for-byte what the machine did before. A log line with no `partial`
field folds as it always did, so the swap is inert on every lane already on disk and `lane migrate`
takes it without drift.

## Consequences

- An operator re-dispatched on a partially-shipped issue reaches `queued`, a state it can spawn
  against, rather than a terminal with no door.
- The loop is unbounded by design and cannot spin: every traversal of the partial arm costs a real
  merged pull request, so a lane that goes round twice has landed twice.
- The guard is namespaced rather than spelled bare because a bare word falls through to the budget
  guard — a typo would compile, match nothing, spend a wait, and fold the lane to the terminal this
  arm diverts it from. Same failure ADR 0317 named on the class axis.
- An epic tail's `ship` (rendered by `lane/emit.ts`) carries the same shape and is **not** covered
  here: its region starts at `review`, so there is no `queued` for a partial tail merge to return to,
  and where it should go is a separate question.
- A lane that folded to `complete` on a partial merge before this shipped stays folded — the routing
  fact is a payload on the recorded line, and no offline replay can invent one. That verb is now
  written: ADR [0344](0344-a-correction-supersedes-a-recorded-line.md) adds an appended correction
  line and the `lane reconcile` sweep that writes it (#7433).
