---
id: 0285
title: An epic's machine ends in one epic-level review state, never a re-review of its children
status: accepted
date: 2026-08-17
tags: [fabrika, pipeline, review, epics, lane]
---

# 0285 — An epic's machine ends in one epic-level review state, never a re-review of its children

**What this decides:** an epic gets exactly one review above its children — a state in the emitted
lane machine, sitting between the last phase and `complete`, that reviews the epic's merged range.
Each child's own review still happens once, inside its own region, and one PR per child stays the
shape.

## Context

Retiring `build-epic` ([#5731](https://github.com/kamp-us/phoenix/issues/5731)) drops a property
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
child's `review` judges that child's PR against that child's own acceptance criteria. So nothing
looks at the epic as a whole: two children can each pass their own gate and contradict each other, a
child can satisfy its criteria while breaking the epic's stated goal, and an epic can land half its
children and stop. `fabrika lane status` folds the ledger, which is control flow, not a diff.

One PR per child is [#5680](https://github.com/kamp-us/phoenix/issues/5680)'s stated design, ruled
and not in question. The open question, filed as
[#5784](https://github.com/kamp-us/phoenix/issues/5784), was only whether the dropped property needs
a replacement. The founder ruled on 2026-08-17 that it does, and named the shape.

This supersedes and amends nothing. It sits beside
[0283](0283-local-ledger-holds-ownable-orderings.md), which draws the line between what the local
lane ledger may own and what stays on the board: an epic-review verdict is a verdict, so it lives on
GitHub like every other one, and only the state that *sequences* the review lives in the machine. It
also completes a pair rather than duplicating one: [0047](0047-review-plan-gate.md) gates an epic's
*plan* before any child is built; this gates the epic's *result* after every child has shipped.

## Decision

**An epic's emitted lane machine ends in one epic-level review state — between the last phase and
`complete` — that reviews the epic's merged range as one change, and per-child review inside each
region stays the inner trust unit.**

Two halves, and the split is the whole point.

*The inner unit is already trusted.* An operator run encompasses the agent spawns beneath it, so
every commit is reviewed locally as it lands, against the child issue that asked for it. That local
review is the cheap one — small diff, small context, one issue's criteria. The epic-level state
therefore reviews the merged range for coherence, not correctness re-run: cross-child
contradictions, drift from the epic's stated goal, and children that landed against a topology that
changed under them. Re-reviewing every child's diff at the epic level would pay the token cost twice
and buy the second-cheapest signal.

*The machine definition is where a structural guarantee belongs.* This is encoded as a state, not a
convention a driver is expected to remember. A state cannot be skipped by an agent that forgot, it
shows up in `lane status`, and it is deterministic output of `emitMachine` for every epic — a
convention living in a skill's prose is none of those things.

**Binding constraints.**

- One PR per child region stands. This record does not reverse #5680's shape, does not reintroduce a
  single epic branch, and is not a step back toward `build-epic`.
- Per-child `review` is untouched. The epic-level state never re-judges a child's PR against that
  child's acceptance criteria — that verdict already exists and is in force.
- The guarantee is a state in `emitMachine`'s output, never a step a driver or skill is trusted to
  perform. A shape that puts it anywhere but the machine definition does not satisfy this record.
- The review's scope is a commit range, not a PR. Whatever seam is built for it must accept that
  scope rather than fold the epic back into a pull request to make an existing reviewer fit.
- The epic-level verdict is a verdict: it lives on GitHub, not in the local lane ledger
  ([0283](0283-local-ledger-holds-ownable-orderings.md)).

The build is a separate issue. This record decides the shape and nothing else.

## Consequences

Easier: an epic has an answer to "review this as one change" again, and it is one the reader finds
in `workflow.json` rather than in a skill's prose. The property `build-epic` bought survives its
retirement without the single-branch cost that made `build-epic` worth retiring.

Harder: the emitter grows a spawn seam and the review surface grows a scope it does not have today —
a merged commit range instead of a pull request. An epic also stops being done the moment its last
child ships; it is done when the epic-level state passes. That interacts with
[0131](0131-epic-autoclose-on-all-children-closed.md), which closes an epic on all-children-closed:
the auto-close still fires on the GitHub edge and is unchanged by this record, so an epic's issue can
close while its lane is still in the review state. The building issue owns reconciling those two, and
this record does not pre-decide it.

## Records

no vocabulary impact — epic-level review, lane machine, region and phase are all already the
#5680/#5688 vocabulary; nothing is coined or redefined here.

Sources: [#5784](https://github.com/kamp-us/phoenix/issues/5784) (the question and the founder's
ruling, comment 5310867155), [#5680](https://github.com/kamp-us/phoenix/issues/5680) (the one-PR-per-child
design), [#5731](https://github.com/kamp-us/phoenix/issues/5731) (the `build-epic` retirement this
unblocks), [`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts).
