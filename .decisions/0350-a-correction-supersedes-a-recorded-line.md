---
id: 0350
title: A correction supersedes a recorded line
status: accepted
date: 2026-09-01
---

# A correction supersedes a recorded line

## Context

ADR [0343](0343-a-partial-merge-sends-the-lane-round-again.md) taught the lane machine to send a
merged `Part of #N` back to `queued` instead of folding to `complete`. The routing fact rides the
recorded event as a `partial` payload, and its own last Consequence names the hole that leaves: a
lane whose ship `DONE` was written before that field existed replays through the guard's
fallthrough and still folds to a terminal over an open, buildable issue.

Nothing could repair one. The fold is total over `events.jsonl` from scratch on every run, so the
state is the log; `lane transition` refuses out of the `shipped` final, which holds no cell for any
event; and no verb in the group could amend a line. #7433 counted two live instances — lanes 6980
and 7382 — with `lane status` reading `complete`, `build eligible` reading `eligible`, and an
operator dispatched on either parking on `LANE-TERMINAL`.

The log being append-only is what everything else here rests on: ADR 0312 moved the retry grant out
of mutable context and onto a recorded line precisely so a fact recorded today could not change how
yesterday's event routed. So the repair could not be a rewrite, and the population was uncountable
without a sweep — nobody knew how many lanes were in this state.

## Decision

**A correction is an appended line that names an earlier line and supersedes its routing payload.**
Three pieces:

1. `<TASK>.CORRECTED` is the eighth event and reaches no machine. It carries `corrects` — the `at`
   of the earlier entry of the same task — and the `partial` that entry should have had. No state
   holds a cell for it, and `applyEvent` refuses it the way it refuses `CLEARED`: it is appended by
   one verb, never transitioned.
2. The fold resolves corrections before dispatching any message (`applyCorrections`). A correction
   is removed from the replayed log and its payload is written onto the entry it names, so the
   machine sees exactly the log that should have been recorded. Corrections apply in log order; a
   later one supersedes an earlier one over the same line.
3. `lane reconcile` is the sweep that writes them. It finds the candidate offline — the latest
   recorded event that took a `merge:partial` cell's fallthrough carrying no answer, located off the
   compiled machine rather than off a state-name list — then reads that one merge's closure through
   `traceClosure`, `lane prove`'s own ship-stage judgement, and appends only on a proven `Partial`.

**The closure is read off the pull request the recorded line already names, not off a nomination.**
A nominator answers "which PR is this issue's", and the terminal being corrected answered that in
writing. It would also answer wrongly: a **merged** `Part of #N` is invisible to both nomination
reads, since the closing edge is built from closing keywords and the search half is `is:open`, so
their union finds nothing for exactly the case this verb catches. Reading the named PR is one
request, exact, and needs no widening of a read three other verbs depend on. A line naming no PR
falls back to the nominator, which is the best answer available without evidence on the line.

**A correction addresses its target by that target's own `at`, and ambiguity is a defect.** A line
number would not survive a reader that skips blank lines; a position would not survive an append.
The timestamp is stable under every later append, and a `corrects` matching no entry of its task —
or matching more than one — is refused at the parse or at the fold, never resolved by picking. That
is the same shape ADR 0312 gave a roundless `CLEARED`: a payload that would fold as a silent no-op
is a defect rather than an event.

**A machine that declares no merge-closure guard is not settled, it is unjudgeable.** Every lane
booted before 0343 shipped is in that state, and reading it as "nothing to correct" is the same
permissive fold one level up. `lane reconcile` reports it as `unmigrated`, naming `lane migrate` as
the step before this one — and only where the committed template the lane booted from declares the
guard, so an emitted epic machine and an epic tail (which declares none by design, 0343's own
carve-out) still read `current`.

## Consequences

- Nothing in `events.jsonl` is ever rewritten or deleted. A repaired lane's log carries both lines,
  and `lane history` prints both, so what was recorded and what corrected it are both readable.
- The repair is its own verb rather than a `lane migrate` arm. That sweep writes `workflow.json`
  only where the swap is **provably inert**, which is ADR 0313's guarantee; appending an event is
  the opposite of inert, and folding the two would spend that guarantee on a different question.
- The correction mechanism is general — the field is a payload, not a merge-specific one — but only
  `partial` is corrigible today. Widening it is a decision, not an extension: every payload the fold
  reads is a routing fact some event's polarity already committed to, and a correction that could
  rewrite a class or a wait grant would let a sweep re-route rounds a lane has walked past.
- `lane reconcile` is ordered after `lane migrate`, and says so on the row rather than leaving the
  operator to know it. Run out of order it corrects nothing and reports why.
- An already-broken ledger is a row at exit 0; only an append this run tried and could not land
  refuses, because only that one leaves whether the lane still needs correcting UNKNOWN.
