---
id: 0297
title: A lane task's `frozen` is a park with a door out, and the door hands out no retries
status: amended-in-part by [0302](0302-known-parks-clear-novel-routes-human.md), [0312](0312-event-anchored-retry-budget.md), [0350](0350-a-correction-supersedes-a-recorded-line.md)
date: 2026-08-18
tags: [fabrika, lane, pipeline, state-machine]
---

# 0297 — A lane task's `frozen` is a park with a door out, and the door hands out no retries

**What this decides:** a task that burned its retry budget can be sent back into the run by a
recorded `UNBLOCKED`, it still trips the lane while it sits there, and coming back buys it nothing —
the next failure freezes it again.

## Context

`frozen` was `{"type": "final"}` in all three lane machine sources — the coder template, the chore
template, and the epic-child machine `lane/emit.ts` builds — with no event out of it. When the
founder granted an extra repair round on a lane already sitting in `frozen`, the grant could only
exist as issue prose the machine cannot see. Two milestone-46 lanes were stuck on exactly that at
filing (#6006 under epic 5817, and 6037).

The founder ruled it on [#5909](https://github.com/kamp-us/phoenix/issues/5909): option 1, a door
back to the state the task left, retries held. Option 2 — abandon the frozen lane and open a fresh
one per clearance — lost because a lane is the whole run's ledger for one issue
(ADR [0283](0283-local-ledger-holds-ownable-orderings.md)): a second lane splits one issue's history
across two ledgers, restarts the retry count at zero, and hands the loop a fresh budget nobody
granted. The thing a clearance exists to buy is one more round, not a clean slate.

The load-bearing constraint is that the compiler derives its sets structurally, never by name
(ADR [0290](0290-retire-epic-conduction-onto-lane-machines.md) is what put every epic on this
machine). `finals` is exactly the `type: "final"` states; a guarded FAIL's fallthrough joins
`errorFinals` only when it is in `finals`; and `deriveStatus` reads a task as the lane's error
condition off `errorFinals`. Dropping `"type": "final"` from `frozen` to give it an `on` would have
taken it out of both sets at once: a frozen lane would stop reading as tripped, and its phase would
never fold at all, so the run would hang instead of ending loud.

## Decision

**A `final` that carries an `on` is a park rather than an end: it stays in `finals` and
`errorFinals`, and the door out stays walkable.**

`frozen` keeps `"type": "final"` and gains `"<TASK>.UNBLOCKED": "hist"` in all three machine
sources. Nothing about the trip changes — the phase still folds on it, `lane status` still reads it
as the lane's error condition, and a lane whose only unfinished task is frozen still ends at
`tripped` rather than hanging. What changes is that `applyEvent`'s "workflow is done, no further
events" refusal admits one case: an event addressed to a task sitting in an open final, at the
tripped terminal. `complete` admits none, because every task there finished clean and no door leads
out of that.

The resume runs through the same history cell `blocked` and `human:cp-approval` use, which copies
the task's retry count forward. So a resumed task walks back into the state it left with its budget
still spent, and the next `FAIL` freezes it again.

**The door and the retry budget are two different things, and only one of them grants a round.** A
founder clearance recorded through `build clear` writes the round into the lane document's context,
and the compiler adds it to `maxRetries` — so re-folding the same event log resumes the task into
`build` on its own, with no `UNBLOCKED` needed. The door is for a frozen task nobody granted a round
for: a chore lane with no PR to clear, or a park a human fixed out of band. Either way one grant is
exactly one round.

A region booted straight into `frozen` — an epic child whose issue was closed without landing — left
no prior state behind it, so its door resolves back to the park itself. The fold refuses that
`UNBLOCKED` rather than recording a resume that did not move; such a child is re-emitted, not
unfrozen. That refusal is read off the task's own state, never off the lane's fold: an epic phase
holding a booted-`frozen` child beside a still-open sibling never folds at all, so the lane is
`active` and a fold-gated check would let the no-op resume through on exactly the shape the epic
emitter produces.

**Binding constraints.**

- A machine source may give a `final` an `on` only from the operator's six events; the six-event
  vocabulary is unchanged and closed.
- A door out of an error final never widens `maxRetries`. Budget comes from a recorded clearance
  and nowhere else.
- `operate` never records the `UNBLOCKED` itself — clearing a park stays a human's event, as it
  already is for `blocked` and `human:*`.

## Consequences

`frozen` moves from `LANE-TERMINAL` to `LANE-PARKED` in
[`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md), which is the honest reading now:
someone can act on it. A `tripped` fold is therefore no longer proof that a run is over, and a
driver reading one has to look at which state the error task sits in.

The cost is that a park can be walked repeatedly with no new grant, each pass ending in the same
freeze. That is deliberate — the door records a human's decision to try again, and the budget guard
is what stops the loop from spending anything on it.

## Records

No vocabulary impact. `frozen`, `LANE-PARKED` and `LANE-TERMINAL` are the `operate` skill's own
terminal vocabulary, defined there rather than in `.glossary/TERMS.md`.
