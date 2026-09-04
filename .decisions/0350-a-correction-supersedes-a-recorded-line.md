---
id: 0350
title: A correction supersedes a recorded line
status: amended-in-part by [0351](0351-a-confirmed-closure-is-recorded-not-re-read.md)
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
   (ADR [0351](0351-a-confirmed-closure-is-recorded-not-re-read.md) widened that last clause: a
   proven `Closes` is appended too, carrying `partial: false`, so the lane is read once rather than
   on every sweep.)

**The closure is read off the pull request the recorded line already names, not off a nomination.**
A nominator answers "which PR is this issue's", and the terminal being corrected answered that in
writing. It would also answer wrongly: a **merged** `Part of #N` is invisible to both nomination
reads, since the closing edge is built from closing keywords and the search half is `is:open`, so
their union finds nothing for exactly the case this verb catches. Reading the named PR is one
request, exact, and needs no widening of a read three other verbs depend on. A line naming no PR
falls back to the nominator, which is the best answer available without evidence on the line.

**A read that proves nothing is `unknown`, never `closes`.** `traceClosure` answers `Closes` when no
merged PR links the issue, which is right where it lives: refusing there would strand a shipper over
a merge that really landed. Read here it inverts, because `closes` leaves the lane at its terminal —
so an empty answer would be the justification for leaving alone exactly the lane this sweep exists to
catch, and the empty answer is the common case rather than the rare one. The PR-less fallback lands
on it by construction, a merged `Part of #N` being invisible to both nomination reads; so does a
named PR that is not merged; so does one whose body carries both link kinds. `provenClosure` refuses
it: only a merged pull request that really links this issue reaches `traceClosure`'s judgement at
all.

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

## Relationship to ADR 0297 and ADR 0322

Two live records read, on their face, as barring what this one ships. Both are named here rather than
left for the next reader to collide with.

**ADR [0297](0297-frozen-is-a-park-not-an-end.md) closes the event vocabulary at the operator's six,
and this adds an eighth.** It is not an operator event, and the shape is ADR
[0312](0312-event-anchored-retry-budget.md)'s exactly: no human records a `CORRECTED` with `lane
transition`, `lane reconcile` appends it; the operator's six are unchanged and `applyEvent` refuses
this one by name. 0297's constraint that a `final` may carry an `on` only from the six is unchanged
for transitions — `CORRECTED` targets no state, so it opens no door out of any final. 0297 is amended
in part again, and its frontmatter says so.

**ADR [0322](0322-closed-issue-lanes-demote-at-read-time.md) rules that reconciliation is a
derivation on read, not a verb someone runs — "no reconciliation verb", "nothing is written".** Its
subject is a fact the lane never performed: the issue was closed outside the lane's own flow, so no
recorded line is wrong, and the principle behind the ruling is that the ledger records what the lane
itself did. This record's subject is the mirror image — an act the lane did perform, a merge that
landed, whose recorded line omitted the routing payload it should have carried. Correcting a
mis-recorded own-act keeps the ledger a record of what the lane did rather than turning it into a
record of the board. 0322's mechanism stands wherever its subject reaches: `lane reconcile` nominates
only a line that sat on a `merge:partial` cell, so a lane whose issue closed elsewhere is nominated
by nothing here and is still demoted at read time by `lane view`.

**0322 is a transcribed founder ruling, not an engineering call.** The distinction above is this
record's reading of that ruling's scope, not a re-decision of it. If the reading is wrong — if "no
reconciliation verb" was meant to bar any verb that writes a lane against the board, including one
correcting the lane's own recorded act — then the mechanism is the founder's to re-rule, and this
record yields to that call rather than to an argument.

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
- ~~A sweep is not free. Only a nominated lane costs a board read, but a closing merge records no
  `partial` either and so nominates exactly like a partial one: on phoenix's own ledger 228 of the
  298 guard-declaring lanes are read, one serial request each, and a run has already exhausted a
  GitHub rate limit part-way through. `--check` costs the same reads. Bounding the nomination so the
  sweep is cheap is open work, not something this record claims.~~ **Superseded by ADR
  [0351](0351-a-confirmed-closure-is-recorded-not-re-read.md)**, which is that work: the sweep now
  records a confirmed closing read as `partial: false`, so a lane is read once rather than every
  sweep, and the ship stage writes the same field at both polarities. The backlog is still hundreds
  of reads on its first pass; what changed is that it is paid once.
