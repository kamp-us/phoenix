---
id: 0382
title: An epic tail PR must close its epic
status: accepted
date: 2026-09-10
---

# An epic tail PR must close its epic

## Context

ADR [0343](0343-a-partial-merge-sends-the-lane-round-again.md) sent a lane whose merge carried
`Part of #N` back to `queued` instead of folding it to `shipped`, and named the epic tail as the one
region it deliberately left out:

> An epic tail's `ship` (rendered by `lane/emit.ts`) carries the same shape and is **not** covered
> here: its region starts at `review`, so there is no `queued` for a partial tail merge to return
> to, and where it should go is a separate question.

So the tail's two ship cells still route `DONE` to `shipped` on a bare arm. The recognition itself is
already region-blind — `PARTIAL_GUARD` reads `LaneMsg.partial`, which `lane report` lands on any
ship-stage `DONE` whose merge closed nothing — and the tail simply never asks for it. A tail PR that
merges without closing its epic folds the epic lane to `shipped` and then `complete` while the epic
issue is still open, and an operator re-dispatched on it parks on `LANE-TERMINAL` with no door out.
That is the live failure #7382's own reproduction met at the other seam ([#7434](https://github.com/kamp-us/phoenix/issues/7434)).

Three routes were open: mint an epic-tail state for the partial return, route the partial `DONE` to
the existing `human:epic-review` park, or refuse such a PR upstream so the merge never happens.

## Decision

**Refuse the epic's final PR when it does not close the epic. No new lane state.** The founder ruled
it ([ruling comment](https://github.com/kamp-us/phoenix/issues/7434#issuecomment-5617229512),
2026-09-10, restating the 2026-09-02 answer on the same issue), under a lens set for that whole
batch: pick the cheapest option, and add no new gate or token unless a failure actually recurred.

One epic run is one branch and one PR (ADR [0285](0285-epic-machine-ends-in-review.md)), so the
tail PR is the whole run's landing. A tail that does not discharge the epic is not a partial landing
to route around — it is a PR that should not be merged, and the cheap place to say so is where its
body is written.

`fabrika lane assembly-body <epic>` is that seat. It reads the composed body on stdin and relays it
unchanged on stdout when a closing keyword aims at the epic — the same bytes, plus a trailing
newline when the body lacked one, which is `answer`'s doing; otherwise it refuses on `58` and
prints nothing, so the `gh pr create --body-file -` it pipes into opens no PR. `operate`'s fence
stays literal and derives nothing, which is ADR
[0228](0228-scripts-relay-never-derive.md)'s shape.

Its link reader is `issueRefsOf` — the same one `lane/closure.ts` judges the merged PR with. That is
the whole design rather than an implementation detail: the guard refuses exactly the bodies that
reader would later call `Partial` or leave `Unknown`, so the authoring seam and the recording seam
cannot disagree about one body. A second link reader here would be two rules wearing one name.

## Consequences

- **The tail keeps the coder template's `queued` return nowhere, and now on purpose.** The coder
  template routes a partial merge back to `queued` because the criteria that PR left undischarged
  are still buildable by the same lane. An epic's are not: its children's phases built them, the
  tail phase only reviews and ships, and its region's `build` cell exists for the tail's own repair
  round — a cell whose `DONE` returns to `review`, not to a fresh construction. `lane/emit.ts`'s
  `epicRegion` therefore declares no `merge:partial` arm at all, `machine.ts`'s `partialStates`
  stays empty for the tail, and `lane/emit.unit.test.ts` pins both polarities of the tail's `DONE`
  folding to `shipped` so the absence reads as a decision rather than an omission.
- **The refusal is as strong as every other fabrika body guard and no stronger.** A driver who runs
  `gh pr create` without the verb can still open a non-closing tail, exactly as one bypassing
  `build pr` can open a body that guard would refuse. The pipeline's teeth are the verb the skill
  routes through; this adds no second gate at the recorder, because a refusal there would arrive
  after the merge — too late to stop the fold, and early enough only to strand the lane.
- **The `## About this epic` section is unaffected.** `lane/assembly-pr.ts` swaps closing keywords
  out of the lifted Problem paragraph, so a quoted keyword cannot forge the epic's own reference;
  and where one survived, `closure.ts` would read it the same way after the merge.
- **A tail's other closing keywords stay unjudged.** It carries one per landed child by contract, so
  what is required is membership — a closing keyword aimed at the epic itself — never a first match,
  which would answer off whichever child happens to lead.
- `lane` claims the base's three authored-text seats (`3`, `5`, `6`) for the first time, because
  this is the group's first verb taking a body on stdin.
