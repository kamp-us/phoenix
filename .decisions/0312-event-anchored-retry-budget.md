---
id: 0312
title: A lane's repair budget is anchored to a recorded clearance event, never derived from mutable context
status: accepted
date: 2026-08-20
tags: [fabrika, lane, pipeline, state-machine]
---

# 0312 — A lane's repair budget is anchored to a recorded clearance event, never derived from mutable context

**What this decides:** a founder's extra repair round is appended to the lane's event log as its own
`<TASK>.CLEARED` event, so replay honours *when* the grant happened and no already-recorded FAIL ever
re-routes.

## Context

`packages/fabrika-cli/src/lane/machine.ts:187-193` compiles `maxRetries = budgetWith(declared,
cleared)` at replay time, reading `cleared` out of `ctx.clearedRounds` — a field
`packages/fabrika-cli/src/lane/clearance.ts:75-81` mutates in `workflow.json`. The lane log is
append-only and re-folded from scratch on every read, so a value the fold takes from mutable context
is a value that can change how yesterday's events routed.

It did. On lane 6462 / PR #6552 the two halves of one frozen-lane resume, applied in the order a
human applies them, produced two defects:

- [#6570](https://github.com/kamp-us/phoenix/issues/6570) — an `ISSUE.UNBLOCKED` folded `frozen ->
  hist -> review` and restored the state but not the budget: `retries` 2 against a derived
  `maxRetries` of 2, so `review`'s only non-error arm was `ISSUE.PASS`. The lane advertised `active`
  / `review`, which is the signal an operator routes on, and re-froze on the round it spent
  rediscovering that.
- [#6578](https://github.com/kamp-us/phoenix/issues/6578) — the `build clear` the founder then ran
  wrote `"clearedRounds": [3]` nine minutes *after* that `UNBLOCKED`. On the next replay the same
  third `ISSUE.FAIL` evaluated against a budget of 3, took its first arm to `build` instead of
  `frozen`, and stranded the legally-recorded `UNBLOCKED` in a state with no cell for it. Every verb
  folds first, so `lane status`, `lane transition`, `lane brief` and `lane prove` all refused on exit
  4 and the lane could not be driven at all.

Three models were on the table, laid out in [#6597](https://github.com/kamp-us/phoenix/issues/6597)
under epic [#6595](https://github.com/kamp-us/phoenix/issues/6595). The founder ruled **A** on
2026-08-20 at
[#6597, comment 5360228418](https://github.com/kamp-us/phoenix/issues/6597#issuecomment-5360228418).

This record transcribes that ruling. Nothing here re-weighs the fork.

## Decision

**The repair budget is a fold over the events recorded before the point being replayed, and a
clearance is one of those events.**

- **The event kind is `<TASK>.CLEARED`** — `ISSUE.CLEARED` on an issue lane, namespaced like every
  other event by the task it addresses. It carries the round it clears. That name is fixed here so
  [#6598](https://github.com/kamp-us/phoenix/issues/6598) and
  [#6599](https://github.com/kamp-us/phoenix/issues/6599) can build against it.
- **`CLEARED` is a self-targeting cell**, not a transition. It moves no task; it raises the budget
  from its own position in the log forward. A task sitting in `frozen` when a grant lands stays in
  `frozen` — the door out is still `UNBLOCKED`, exactly as ADR
  [0297](0297-frozen-is-a-park-not-an-end.md) rules.
- **`ctx.clearedRounds` is retired.** `machine.ts` stops reading it and `clearance.ts` stops writing
  it; the compiler's `maxRetries` becomes the declared budget, and the fold widens it as each
  `CLEARED` is applied. `packages/fabrika-cli/src/cap-clearance.ts` stays the one derivation both
  readers share — only the local source of the rounds list moves.
- **The board half of a grant is unchanged.** `build clear` still posts the `cap-cleared: round N`
  marker on the PR, and `build verdicts`' `capReached` still folds those markers. Per ADR
  [0283](0283-local-ledger-holds-ownable-orderings.md), that ordering arbitrates between checkouts
  and stays on GitHub; what moves local is only the drive-loop half, which is exactly what the lane
  ledger is for.

**The budget representation is stable under replay.** Every event is evaluated against the budget
that existed at its own position, so a recorded FAIL keeps the routing it actually took, forever. No
later write re-routes it. This is what closes #6578: the destructive order is no longer reachable,
because appending a `CLEARED` after an `UNBLOCKED` changes nothing about how that `UNBLOCKED`
replayed.

**A frozen-lane resume regains a walkable non-PASS route from the `CLEARED` event and from nothing
else.** ADR 0297 binds here and is not loosened: the door out of an error final hands out no
retries. With a `CLEARED` in the log the resumed task lands back in `review` with `retries <
maxRetries` true, so `ISSUE.FAIL` has its `build` arm and the lane is walkable — and both orders
work, `CLEARED` then `UNBLOCKED` or the reverse, which is what closes #6570's half. With no `CLEARED`
anywhere in the log there is no budget and no non-PASS route, and that is now derivable from the log
alone rather than from mutated context; #6598 makes it a stated refusal at resume time instead of a
silent `active`.

**Binding constraints.**

- No guard context a verb mutates may be read at replay time. A fact the fold consults is either
  declared once in the template or recorded as an event. This generalizes past the retry budget: any
  future mutable-context guard has the same hazard #6578 hit.
- One grant is still exactly one round. `CLEARED` is keyed by the round it clears and set-semantic,
  so a re-run or a double-recorded grant buys nothing — the reconciliation property
  `clearance.ts` already holds is preserved by the event key, not by the writer.
- A `CLEARED` below the declared cap is never honoured, per `cap-clearance.ts`'s existing rule.

## Relationship to ADR 0297

0297 is amended in part. Its ruling stands whole: `frozen` is a park with a door out, the door hands
out no retries, and one grant is one round. Two of its mechanics change.

- 0297 states that a clearance "writes the round into the lane document's context, and the compiler
  adds it to `maxRetries`". That is the mechanism this record replaces, and it is the mechanism
  #6578 reports as destructive.
- 0297 closes the event vocabulary at the operator's six. This adds a seventh, `<TASK>.CLEARED`, and
  it is not an operator event: no human records it with `lane transition`, `build clear` appends it.
  0297's constraint that a `final` may carry an `on` only from the six is unchanged for transitions —
  `CLEARED` targets nothing, so it opens no new door out of `frozen`.

## Consequences

Easier: a lane's full retry history is readable from its log alone, in order, with no second document
to consult. A founder can grant a round at any point in a resume without a destructive ordering
existing to fall into.

Harder: every lane carrying a `clearedRounds` in its `workflow.json` today is a lane whose grant the
new compiler cannot see. Re-recording it as a `CLEARED` event is the repair; #6599 does exactly that
for the live incident on lane 6462, and lane ledgers are per-tree and gitignored, so there is no
fleet-wide migration behind it.

The fold gains a message that changes context rather than state, which the machine table had no
instance of before. That is a real widening of what a lane event may be, and the binding constraint
above is what keeps it from becoming a general escape hatch.

## Records

No `.glossary/TERMS.md` row. Following 0297's precedent, the lane machine's event vocabulary is
defined with the machine and the [`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md)
skill, not in the product glossary; `<TASK>.CLEARED` is coined here and lives there.

Sources: the founder ruling at
[#6597, comment 5360228418](https://github.com/kamp-us/phoenix/issues/6597#issuecomment-5360228418);
[#6570](https://github.com/kamp-us/phoenix/issues/6570), [#6578](https://github.com/kamp-us/phoenix/issues/6578),
epic [#6595](https://github.com/kamp-us/phoenix/issues/6595);
[`packages/fabrika-cli/src/lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts),
[`packages/fabrika-cli/src/lane/clearance.ts`](../packages/fabrika-cli/src/lane/clearance.ts),
[`packages/fabrika-cli/src/cap-clearance.ts`](../packages/fabrika-cli/src/cap-clearance.ts).
