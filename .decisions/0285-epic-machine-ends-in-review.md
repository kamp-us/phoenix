---
id: 0285
title: An epic run produces one PR, and its machine ends in one review of that PR
status: accepted
date: 2026-08-17
tags: [fabrika, pipeline, review, epics, lane]
---

# 0285 — An epic run produces one PR, and its machine ends in one review of that PR

**What this decides:** one epic lane run = one branch, one PR. Children land as commits on that
shared branch and each child's review judges its own commit range locally, on the machine, with no
push and no CI run. The machine then ends in one epic-level review state that reviews the single PR
as a whole, and the merge happens once.

## Context

Retiring `build-epic` ([#5731](https://github.com/kamp-us/phoenix/issues/5731)) dropped a property
nothing replaced. `build-epic` conducted an epic into one branch and one PR, so an epic had exactly
one reviewable unit. The replacement engine does not:
[`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts) renders one
region per child (`region()` — `queued → build → review → ship → shipped`), groups regions into
phases, sequences phases by `onDone`, and then ends:

```ts
states.complete = {type: "final"};
states.tripped  = {type: "final"};
```

`complete` is bare. Nothing runs between the last child shipping and the machine finishing, and each
child's `review` judges that child's own PR against that child's own acceptance criteria. So nothing
looks at the epic as a whole: two children can each pass their own gate and contradict each other, a
child can satisfy its criteria while breaking the epic's stated goal, and an epic can land half its
children and stop. `fabrika lane status` folds the ledger, which is control flow, not a diff.

That was the question filed as [#5784](https://github.com/kamp-us/phoenix/issues/5784). The founder
first ruled that the missing epic review is real and must be a state. He then
[re-ruled the surrounding shape](https://github.com/kamp-us/phoenix/issues/5784#issuecomment-5310972958)
on 2026-08-17: an epic run produces **one PR total**, not one per child. His earlier "we can trust
each commit is reviewed locally" meant commits inside one PR; the per-child-PR reading was the
driver's, and he corrected it directly ("I WANT A SINGLE PR FOR EACH WORKFLOW").

The reason is cost, and it is the design center rather than a bonus
([rationale](https://github.com/kamp-us/phoenix/issues/5800#issuecomment-5310985901)): moving the
build → review → repair loop onto the machine makes a FAIL-repair round cost zero pushes, zero CI
runs and zero board writes. The per-child-PR lanes that ran that night each spent one to two repair
rounds through GitHub. That round trip is what this removes.

This reverses [#5680](https://github.com/kamp-us/phoenix/issues/5680)'s one-PR-per-child shape, for
epic lane runs only. #5680's phase-3 children already shipped under the old shape and that history
stands. Single-issue lanes are untouched: one issue, one PR, as today.

It sits beside [0283](0283-local-ledger-holds-ownable-orderings.md), which draws the line between
what the local lane ledger may own and what stays on the board: a review verdict is a verdict, so it
lives on GitHub, and only the state that *sequences* a review lives in the machine. It also completes
a pair rather than duplicating one: [0047](0047-review-plan-gate.md) gates an epic's *plan* before
any child is built; this gates the epic's *result* before the one PR merges.

## Decision

**An epic lane run produces one branch and one PR. Each child's region reviews that child's commit
range locally on the branch, and the machine ends — between the last phase and `complete` — in one
epic-level review state that reviews the single PR as a whole.**

Two halves, and the split is the whole point.

*The inner unit is local and range-scoped.* An operator run encompasses the agent spawns beneath it,
so every child's commits are reviewed as they land, against the child issue that asked for them,
without leaving the machine. That review is the cheap one — small diff, small context, one issue's
criteria — and a FAIL sends the child straight back into repair with nothing published. Nothing
reaches GitHub until the child's range passes.

*The outer unit is the PR.* The epic-level state reviews the one PR for coherence, not correctness
re-run: cross-child contradictions, drift from the epic's stated goal, and children built against a
shape that changed under them. Re-reviewing every child's diff there would pay the token cost twice
for the second-cheapest signal.

**Binding constraints.**

- One PR per epic **run**, not per child. One branch, children as commits on it, one merge at the
  end. A shape that opens a PR per child does not satisfy this record.
- Per-child review is local and range-scoped. It judges a commit range on the shared branch, runs
  entirely on the machine, and its build → review → repair rounds cost zero pushes, zero CI runs and
  zero board writes.
- The epic-level review reviews the single PR as a whole, and never re-judges a child's range against
  that child's acceptance criteria — that verdict already exists and is in force.
- The guarantee is a state in `emitMachine`'s output, never a step a driver or skill is trusted to
  perform. A convention in a skill's prose can be skipped by an agent that forgot, does not show up
  in `lane status`, and is not deterministic output; a state is all three.
- Verdicts are verdicts: the per-child range verdicts and the epic verdict live on GitHub, bound to
  the range or the PR they judge, not in the local lane ledger
  ([0283](0283-local-ledger-holds-ownable-orderings.md)).
- Single-issue lanes keep one PR per issue. Nothing here touches them.

The build is a separate issue. This record decides the shape and nothing else.

## Consequences

Easier: an epic has one reviewable unit again — the property `build-epic` bought, without
`build-epic`. The repair loop stops paying GitHub for every round: a child that fails review costs a
local retry instead of a push, a CI run and a board write. The board surface shrinks to the one PR,
the range-bound verdicts, and the terminal epic review.

Harder: the emitter grows a spawn seam, the branch is now shared across children so regions can no
longer be treated as independent trees, and the review surface grows a scope it does not have today —
a commit range on a live branch, not a pull request. An epic also stops being done when its last
child's commits land; it is done when the epic review passes and the one PR merges.

That interacts with [0131](0131-epic-autoclose-on-all-children-closed.md), which closes an epic once
all its children close, and the one-PR shape deepens it: children now close as their ranges land,
before the single PR exists in a mergeable state, so an epic issue can auto-close while its lane is
still building, still in the epic review, or waiting on the merge. The auto-close fires on the GitHub
edge and is unchanged by this record. The building issue owns reconciling the two, and this record
does not pre-decide it.

## Records

no vocabulary impact — epic-level review, lane machine, region and phase are all already the
#5680/#5688 vocabulary; nothing is coined or redefined here.

Sources: [#5784](https://github.com/kamp-us/phoenix/issues/5784) (the question and the founder's
[re-ruling](https://github.com/kamp-us/phoenix/issues/5784#issuecomment-5310972958)),
[#5800](https://github.com/kamp-us/phoenix/issues/5800) (the
[rationale amendment](https://github.com/kamp-us/phoenix/issues/5800#issuecomment-5310985901) — the
local loop is the point), [#5680](https://github.com/kamp-us/phoenix/issues/5680) (the one-PR-per-child
design this reverses for epic runs), [#5731](https://github.com/kamp-us/phoenix/issues/5731) (the
`build-epic` retirement this unblocks),
[`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts).

## Amendment — 2026-08-20: the tail gains a `build` repair cell, and its review FAIL routes there

Founder ruling,
[2026-08-20](https://github.com/kamp-us/phoenix/issues/6521#issuecomment-5361635581), on
[#6521](https://github.com/kamp-us/phoenix/issues/6521). This amendment transcribes it.

The tail region this record decided had `review → ship → shipped` and nothing else. A child region
carries a `build` cell, so a child's `FAIL` has somewhere to go; the tail's `FAIL` retry arm pointed
at `review` itself. The facts a tail review actually fails on are not a reviewer's to change — an
assembly branch gone `CONFLICTING` against a `main` that moved under it, a head with no CI — so the
edge re-dispatched the shell that had just produced the verdict, spent the tail's round, and reached
the human park anyway. Live instance: epic [#4306](https://github.com/kamp-us/phoenix/issues/4306),
PR [#6434](https://github.com/kamp-us/phoenix/pull/6434). It recurs by construction: the assembly
ages against a moving trunk while the children build.

**The tail region gains a `build` cell**, with the child region's two edges — `DONE` back to
`review`, `BLOCKED` to `blocked` — and the `review` `FAIL`'s retry arm targets it under the existing
`retriesRemaining` guard. The fallthrough is unchanged. `ship` and `ship:queued` keep their `review`
arm: a shipper fails on the PR's own mergeability, which the next verdict over the same head answers.

**A repair round is briefed on the assembly branch.** `lane brief` used to fall through to a `Pull`
ground for any build state, so a builder sent to repair the assembly was told the PR and no branch.
The tail at `build` now emits its own ground carrying the run's one PR, the epic issue and
`epic/<lane-key>`, under a byte-fixed rules paragraph of its own.

**The assembly-branch merge is the driver's, not the repair builder's.** The assembly worktree
belongs to the lane driver and no spawned shell can reach it
([#6517](https://github.com/kamp-us/phoenix/issues/6517)), so the repair round's rules say so and
name the move: the driver runs `lane refresh`, which merges `main` into `epic/<lane-key>`. **Merge,
never rebase** — each landed child's range verdict is bound to the commits it names, and a rebase
rewrites every one of them.

**A lane already emitted does not adopt the cell.** `lane migrate` reports a generated epic machine
`Foreign` and writes nothing, and the ruling picked no direction for the mid-drive case; that gap is
[#6857](https://github.com/kamp-us/phoenix/issues/6857). This amendment builds no migration path.

One thing the issue's own acceptance criteria asked for was **not** built, and deliberately: they
named `frozen` as the FAIL array's fallthrough. That target moved to `human:budget-spent` after the
issue was written, for the reason
[0378](0378-driver-seat-on-a-spent-repair-budget.md) records — `recipe/parks.ts`'s `isPark` matches
`blocked` and `human:*` and never `frozen`, so a tail exhausting into `frozen` parks where every
recipe answers `NotParked`. The shape the criterion asked for (a `{type: "final"}` carrying an
`UNBLOCKED` door to `hist`) is exactly what `human:budget-spent` already is, so the criterion is met
under the name that works and the retired one is not reintroduced.

Sources: the [ruling](https://github.com/kamp-us/phoenix/issues/6521#issuecomment-5361635581),
[#6521](https://github.com/kamp-us/phoenix/issues/6521),
[`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts),
[`packages/fabrika-cli/src/lane/brief-verb.ts`](../packages/fabrika-cli/src/lane/brief-verb.ts),
[`packages/fabrika-cli/src/wire/lane-brief.ts`](../packages/fabrika-cli/src/wire/lane-brief.ts).
