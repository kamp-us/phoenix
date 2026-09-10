---
id: 0377
title: A machinery failure spends a lap, and only a content FAIL spends the repair budget
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline, state-machine]
---

# 0377 — A machinery failure spends a lap, and only a content FAIL spends the repair budget

**What this decides:** the pipeline failing to carry a correct artifact through no longer costs the
ticket a repair round. It records a lap against its own counter, and the repair budget is left for
the verdicts it exists to answer.

## Context

The founder ruled the axis on the walk at
[#8807](https://github.com/kamp-us/phoenix/issues/8807), on
[the ruling comment](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081): *"yes,
but i think fabrika proved enough that we can increase the cap"*, in a turn whose complaint was that
almost every session was *"about you telling me that something is parked."* R5.2 raises the repair
cap to 3, which ADR [0374](0374-driver-seat-on-a-spent-repair-budget.md) records. R5 also splits the
budget, and that is this record.

`FAIL` was one event doing two jobs. A reviewer grading an artifact wrong and a child colliding at
integrate both arrived as `FAIL` and both spent a repair round, so a run could clear its whole budget
without a single verdict against the work in it — one epic did exactly that. Four machinery failures
did it routinely: a child colliding when its range was replayed onto the assembly tip, the trunk
drifting under an epic tail, a merge-queue ejection, and a seat left dirty by a finished lane. A
fifth arrived with [#8821](https://github.com/kamp-us/phoenix/issues/8821) — a shell the provider
killed mid-stage. None of them says anything about the artifact, and charging the ticket for them is
charging the wrong account.

ADR [0313](0313-a-queue-dwell-is-a-wait-not-a-park.md) already drew this line once, for the queue
dwell: a clean PR sitting in the queue is a wait the driver re-folds, not a park and not a failure.
The wait axis it created has its own budget for exactly the reason this one needs a separate budget —
counting a different kind of thing against the repair cap makes the cap mean nothing.

## Decision

**The event vocabulary gains a seventh operator event, `LAP`, and a machinery failure records it
instead of a `FAIL`.**

- **Which failures are machinery is a table, not a judgment.** `MACHINERY_CAUSES` in
  [`lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts) binds each machinery terminal to its
  own park cause — `REPLAY-COLLIDED` → `replay-conflict`, `BASE-DRIFTED` → `head-behind-base`,
  `QUEUE-EJECTED` → `queue-ejected`, `SEAT-DIRTY` → `worktree-holds-branch`, `SHELL-DEAD` →
  `spawn-dead` — so a recorder types no `--cause` flag and a lap that names no machinery cannot be
  recorded. Every one of those causes routes to the driver under ADR
  [0376](0376-driver-seat-for-non-product-parks.md).
- **A lap spends `laps`, against `MACHINERY_LAP_BUDGET`.** The constant sits beside `RETRY_BUDGET` in
  [`retry-budget.ts`](../packages/fabrika-cli/src/retry-budget.ts) under the same fail-closed drift
  test, at 16. It is deliberately not `RETRY_BUDGET`, on the same reasoning that keeps the wait
  budget off it, and it is a tuning dial the weekly machinery review revisits against counted laps —
  not a derivation.
- **Lap exhaustion parks rather than freezes.** The guarded lap arms fall through to
  `human:machinery-stall`, a plain state with an `UNBLOCKED` door — not an error final — because
  nothing about the artifact was judged and there is no verdict to answer. The park carries whatever
  machinery cause its last lap named, so it routes to the driver.

**0312's event anchor is kept, whole.** ADR
[0312](0312-event-anchored-retry-budget.md) rules that the repair budget is a fold over the events
recorded before the point being replayed, that a grant is the `<TASK>.CLEARED` event and nothing
else, and that no later write re-routes a recorded event. Every clause of that survives this record
untouched: `CLEARED` is still the only source of a repair round, it is still a self-targeting cell
that moves no task, and a resume with no grant behind it is still `unbudgeted-resume`. **What
narrows is only which events may spend the budget** — a `FAIL` spends it, a `LAP` does not — and a
narrowing of the spenders is not a loosening of the anchor. A reader who takes this as dropping the
event anchor has it backwards: the lap counter is anchored the same way, folded from the events
recorded before the point being replayed, and no mutable context feeds either number.

**The axis is gated at emission and ships off.** `.fabrika.jsonc`'s `machineryLaps.onEmit` ships
`off`, and an emission with it off is byte-identical to the machine that emitted before this axis
existed. The machine is fixed at emission, so no lane already on disk changes arithmetic mid-flight:
a repo opts the axis in for its next emission and nothing else moves. A lane emitted without it
carries no `LAP` cell at all, so a machinery terminal reported against one is refused at exit 12 with
the log untouched — the fail-closed answer, never a silent charge to the repair budget.

**Binding constraints.**

- A repair round is spent by a content `FAIL` and by nothing else. An event that adds a spender to
  that budget re-opens the defect this record closes.
- A machinery terminal's cause is read off `MACHINERY_CAUSES`, never typed by the recorder. A lap
  that names no machinery is not recordable.
- The lap budget is a declared constant. No recorded event raises it — the grant vocabulary
  (`CLEARED`, `--grant-wait`) reaches the repair and wait budgets only.
- `human:machinery-stall` is a plain state, not an error final. Giving it finality would put it in
  `errorFinals` and pull `unbudgeted-resume` over a park no grant was ever meant to gate.

## Consequences

A run's repair budget now measures what a reviewer thought of the work, which is the only thing it
was ever supposed to measure. A driver stops spending founder-facing cap clearances on collisions.

There are three budgets to read instead of one — retries, waits, laps — and a driver reading a park
has to know which was spent. The fold prints all three, and each park's cause names which.

The axis is invisible until a repo declares it, so the epic that added it ships with the numbers
unchanged in this repo, and the first machine to carry laps is the next one emitted after the
declaration.

## Records

Coins **machinery lap** — deliberately not called a retry, so that "retry" keeps meaning a round
spent by a content `FAIL`. Defined in [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) beside the
lane, in this pull request.

Sources: the founder ruling at
[#8807, comment 5611016081](https://github.com/kamp-us/phoenix/issues/8807#issuecomment-5611016081);
epic [#8810](https://github.com/kamp-us/phoenix/issues/8810) and its children
[#8819](https://github.com/kamp-us/phoenix/issues/8819) and
[#8821](https://github.com/kamp-us/phoenix/issues/8821);
ADRs [0312](0312-event-anchored-retry-budget.md) (amended in part by this record),
[0313](0313-a-queue-dwell-is-a-wait-not-a-park.md),
[0374](0374-driver-seat-on-a-spent-repair-budget.md) and
[0376](0376-driver-seat-for-non-product-parks.md);
[`packages/fabrika-cli/src/retry-budget.ts`](../packages/fabrika-cli/src/retry-budget.ts),
[`packages/fabrika-cli/src/lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts),
[`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts),
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts),
[`packages/fabrika-cli/src/config/keys/machinery-laps.ts`](../packages/fabrika-cli/src/config/keys/machinery-laps.ts).
