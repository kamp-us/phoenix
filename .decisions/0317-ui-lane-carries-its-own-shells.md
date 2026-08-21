---
id: 0317
title: A UI-class lane carries its own build and review shells, and the lane state carries the class
status: accepted
date: 2026-08-20
tags: [fabrika, lane, pipeline, review, state-machine]
---

# 0317 — A UI-class lane carries its own build and review shells, and the lane state carries the class

**What this decides:** a lane whose diff raises the `ui` class runs its build and review rounds in
`ui-builder` and `ui-reviewer` shells of its own, reached from lane states named `build:ui` and
`review:ui`. The class rides on the state name, not on a field in the lane brief.

## Context

The two merge-path gates disagreed by construction, and each half was locally right.

`ship gate` requires a verdict for every namespace the diff derives. `ship scope`
([`packages/fabrika-cli/src/ship/scope-verb.ts`](../packages/fabrika-cli/src/ship/scope-verb.ts))
derives that set with `partitionWithUi` / `shipNamespacesOf` from
[`packages/fabrika-cli/src/review/classes.ts`](../packages/fabrika-cli/src/review/classes.ts), so a
diff touching a rendered surface raises `ui` and the gate demands a `review-ui` row.

`lane prove` ([`packages/fabrika-cli/src/lane/prove-verb.ts`](../packages/fabrika-cli/src/lane/prove-verb.ts))
derived its required set from the three-class `partition` / `namespacesOf` instead, and dropped
`review-ui` on purpose. Its standing comment said so outright: the rendered-visual verdict is
`review-ui`'s own lane, the lane machine spawned no shell that emits one, and requiring it would
stall every UI lane on a verdict nothing in the loop writes.

Nothing in the loop could write it.
[`packages/fabrika-cli/src/wire/lane-brief.ts`](../packages/fabrika-cli/src/wire/lane-brief.ts)
closed its routing table at three rows — `build`→`builder`, `review`→`reviewer`, `ship`→`shipper` —
and [`claude-plugins/fabrika/agents/`](../claude-plugins/fabrika/agents/) held five shells, none of
them a UI one. So `prove` let a lane leave `review` one namespace short, `ship gate` then read the
absent `review-ui` row as blocked, and the lane parked on a human. Lanes 6449, 6539, 6577 and 6495
each burned human cycles on it, one of them with a driver hand-firing `review-ui` — which a driver
must never do, because a driver records verdicts and never authors them.

## Decision

The founder ruled direction 1 on 2026-08-20 in
https://github.com/kamp-us/phoenix/issues/6505#issuecomment-5360947091: wire the two shells in. The
loop grows `ui-builder` and `ui-reviewer` shells, the lane routes a UI-class lane to them, and
`lane prove` requires `review-ui` when the `ui` class is raised, so `prove` and `ship gate` compute
one bar.

### Direction 2 is rejected, and this is the arm a later reader will re-propose

Direction 2 was to let `ship gate` treat `review-ui` as advisory on the lanes where `lane prove`
dropped it. It is rejected. It reads as the cheap fix — one predicate, and every stuck lane moves —
but it buys motion by relaxing a fail-closed merge gate, and a gate that waives a namespace because
the loop is not wired to fill it stops being a gate at all. The verdict would then be absent on
exactly the diffs that most need it: the ones that change what a user sees. The deadlock was a
wiring gap, and a wiring gap is fixed by wiring, not by lowering the bar the wiring failed to clear.

### Why the class rides on the state name

A lane's UI-ness is expressed as the state it sits in — `build:ui`, `review:ui` — rather than a
class field on the lane brief.

The machine compiler in
[`packages/fabrika-cli/src/lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts)
dereferences no particular state name. It checks that an initial state and every transition target
exist as keys, and nothing more, so a new state name costs the compiler nothing; `human:cp-approval`
already proves a colon is legal in one.

The brief is the opposite. `lane-brief.ts` enforces a 1:1 state-to-shell map on **both** sides: the
write side composes `shell` from `SHELLS[state]`, and the read side re-derives it and rejects a
brief whose `shell:` field disagrees with its `state:` field. That check is what makes "guess a
shell for an unrouted state" unwritable rather than merely discouraged. A brief that picked its
shell from the diff would break the map — the same state would route two ways — and there is a
harder problem underneath it: a `build` state has no PR, so there is no diff to read a class from at
the moment the build shell is chosen. The state name is the only carrier that is known early enough
and cannot drift from the shell it names.

### Why the text review and the rendered review stay two lanes

They judge different artifacts under different rubrics: `review` judges text against acceptance
criteria, `review-ui` judges rendered surfaces against the design law. A UI PR owes both, so
`review:ui` is an additional round rather than a substitute for `review`.

Merging them — teaching the `reviewer` shell to judge rendered visuals — would re-create the dead
end this work removes. `review`'s contract
([`claude-plugins/fabrika/skills/review/SKILL.md`](../claude-plugins/fabrika/skills/review/SKILL.md))
ends a rendered-visual subject on the *routed elsewhere* terminal, a handoff to `review-ui` that
nothing in the loop was there to receive. Folding the rubrics together does not remove that terminal;
it hides it inside one shell that now owns a modality it cannot judge.

### Why `ISSUE.FAIL` at `ship` routes back to `review`

The single-issue coder template
([`packages/fabrika-cli/src/lane/templates/coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json))
routed `ISSUE.FAIL` at `ship` to `build`, spending a retry. On a green PR refused for a missing
verdict there is nothing at `build` to repair, so the retry is burned before the lane gets its
re-review. It now routes to `review`.

This is not an invention: the epic tail task already has that shape — the golden at
[`packages/fabrika-cli/src/lane/__fixtures__/epic-4300.workflow.golden.txt`](../packages/fabrika-cli/src/lane/__fixtures__/epic-4300.workflow.golden.txt)
routes both `review.FAIL` and `ship.FAIL` back to `review`. The single-issue template was the
outlier.

## Consequences

- A UI-class lane reaches `shipped` with no human hand-firing a round, and no driver authoring a
  verdict.
- `lane prove` and `ship gate` derive from the same partition, so a lane cannot leave `review` on a
  set the merge gate will refuse.
- The routing table grows but stays one table; a state that routes to no shell is still a refusal.
- `prove` tightens **last**. Tightened before the shells and routing exist, it converts today's park
  into a stall, which is worse than the deadlock it replaces.
- Two lane-state nouns become load-bearing: `build:ui` and `review:ui` are where a lane sits;
  `build-ui` and `review-ui` are the skills, and `ui-builder` and `ui-reviewer` the shells that
  load them.

## Records

- Ruling: https://github.com/kamp-us/phoenix/issues/6505#issuecomment-5360947091
- Epic: https://github.com/kamp-us/phoenix/issues/6505
