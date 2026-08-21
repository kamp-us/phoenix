---
id: 0320
title: The review bar splits across the two review cells, and the lane's own machine decides where
status: accepted
date: 2026-08-21
tags: [fabrika, lane, pipeline, review, state-machine]
---

# 0320 — The review bar splits across the two review cells, and the lane's own machine decides where

**What this decides:** `lane prove` proves a `PASS` out of the plain `review` cell against the
derived namespace set **minus** the routed namespaces, and only when this lane's own machine takes
that very event into `review:ui`. Every other `review` `PASS` still stands on the whole set. This
narrows ADR [0317](0317-ui-lane-carries-its-own-shells.md)'s consequence "a lane cannot leave
`review` on a set the merge gate will refuse" from the cell to the phase.

## Context

0317 wired the `ui-builder` / `ui-reviewer` shells and the `build:ui` / `review:ui` states, and made
`lane prove` require `review-ui` whenever the `ui` class is raised. That last half closed a circle.

The coder template's only arm into `review:ui` is the `PASS` out of `review`, guarded on `class:ui`
([`packages/fabrika-cli/src/lane/templates/coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json)).
So requiring `review-ui` **of that event** required a verdict from the cell the lane had not entered
yet — the only cell that could produce one. Every rendered-surface lane refused at exit `23` and
needed a driver to hand-spawn the ui reviewer, which is exactly the act 0317 removed
([#6793](https://github.com/kamp-us/phoenix/issues/6793)).

0317 foresaw the ordering ("`prove` tightens **last**") but not this shape: the tightening is not too
early, it is asked of the wrong event.

## Decision

The bar splits across the two cells. Out of `review` a routed namespace is the next cell's; out of
`review:ui` the whole derived set stands. `ship gate` re-derives all of it at the merge regardless,
so the merge bar is untouched — 0317's rejected direction 2 stays rejected, and nothing here waives
a namespace at the gate.

### The deferral is derived from the machine, never from a constant

The subtraction is legal exactly when this event routes into the cell that owes the work. `lane prove`
asks the compiled cell itself (`nextLeaf` in
[`packages/fabrika-cli/src/lane/fold.ts`](../packages/fabrika-cli/src/lane/fold.ts)), with the same
classes the append will carry, and defers only on `review:ui`.

Hardcoding the subtraction to the `review` cell was the first shape, and it was wrong in two ways
that a reader will re-propose because the code is shorter:

- **A machine with no such arm.** A `chore` workflow has no `review:ui` state
  ([`templates/chore.workflow.json`](../packages/fabrika-cli/src/lane/templates/chore.workflow.json)),
  so a lane on it defers to a cell that does not exist and walks to `ship`.
- **A class nobody relayed.** The arm is guarded on `class:ui`, seeded by a reviewer's
  `lane report … --class ui`. Omit the flag on a rendered diff and the guard does not hold: the lane
  takes the `ship` arm, and a constant subtraction would still have dropped the namespace.

In both cases the lane lands on `ship gate`'s refusal — the wasted ship dispatch and park
[#6664](https://github.com/kamp-us/phoenix/issues/6664) set out to remove, reintroduced on the paths
nobody was looking at. `lane prove` exists because a report can lie; making its proof depend on a
class value supplied by that same report, with nothing checking the class routes anywhere, is the
one thing it may not do. Reading the arm off the machine is what makes the flag's absence visible:
no arm, no deferral, and the old floor stands unchanged.

### Why not tighten `ship gate` instead, or drop the class guard

Tightening the merge gate answers a different question — it already requires the full set. Dropping
the `class:ui` guard so every lane walks through `review:ui` would send text-only PRs to a gate whose
`render` refuses a zero-`--surface` run, turning a clean lane into a park. The class guard is 0317's
own routing decision and stays.

## Consequences

- A rendered-surface lane walks `review` → `review:ui` → `ship` with no hand-spawned round.
- A `review` `PASS` that routes anywhere else proves the whole derived set, so the pre-0317 floor is
  intact on every machine shape and on a missing class flag.
- `lane prove` takes the lane classes as an input (`--class`, the same closed set `lane report`
  validates), and `lane report` hands it the classes it is about to append.
- 0317's consequence line now reads at phase granularity: a lane cannot leave the **review phase** on
  a set the merge gate will refuse. Leaving the `review` **cell** on a short set is legal, and only
  toward the cell that fills it.
- The deferred namespace is named on stderr either way — as owed by the cell being entered, or as
  required here with the class flag as the remedy — so a refusal never leaves an operator guessing
  which of the two it hit.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/6664
- Operator-side report of the same deadlock: https://github.com/kamp-us/phoenix/issues/6793
- Narrows: ADR [0317](0317-ui-lane-carries-its-own-shells.md)
