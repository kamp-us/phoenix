---
id: 0426
title: build push opens the PR in the same step, never leaving a pushed lane branch for resume to adopt
status: accepted
date: 2026-09-27
tags: [build, lane]
---

# 0426 — build push opens the PR in the same step, never leaving a pushed lane branch for resume to adopt

**What this decides:** `fabrika build push` also opens the pull request, so a builder that dies
mid-step never leaves a pushed branch with no PR behind it. No resume path learns to adopt such a
branch.

## Context

A build round pushes its lane branch with `fabrika build push` and then opens the PR with
`fabrika build pr`. Those are two steps, so a window between them exists in every round.

A single-issue lane proves its `DONE` out of `build` through one claim: an open PR whose body links
the issue (the `OpenPull` claim in `packages/fabrika-cli/src/lane/prove.ts`). With no PR, `lane prove`
falls through to the no-PR outcome, finds none it can accept, and answers unproven on exit `22`. The
`operate` skill maps that to `BLOCKED`, so the lane parks.

That happened in production. Lane 6924's builder died with `API Error: 529 Overloaded` after it had
pushed `build/6924-kill-fold-human-filed-2970cc7a` to origin and before it opened the PR. The branch
sat on origin with no PR for #6924, and the driver parked a lane whose build had essentially
finished ([#6933](https://github.com/kamp-us/phoenix/issues/6933)).

The question had three parts: close the window by opening the PR in the same step that pushes, teach
the resume path to find and adopt an already-pushed lane branch, and whether a stranded remote branch
needs its own cleanup rule.

## Decision

**PR-open folds into `fabrika build push`, and the resume-adoption path is rejected.**

The founder answered yes to folding and no to adoption
([ruling](https://github.com/kamp-us/phoenix/issues/6933#issuecomment-5519864602), 2026-09-02). The
lens he set is the one [0423](0423-a-no-pr-build-terminal-is-proven-by-its-note-alone.md) applied:
reduce process toil, raise trust between agents and skills, take the cheapest option, and add no new
gate and no new token unless a failure has actually recurred.

The choice changes these surfaces:

- `packages/fabrika-cli/src/build/push-verb.ts` opens the PR after it proves the ref moved. Today it
  ends on `PUSH-VERDICT: MOVED` and does no PR work.
- `packages/fabrika-cli/src/build/pr-verb.ts` stops being a separate step in a build round. Its
  guarded create, which already answers `existing` for an open PR on the head branch, is what the
  folded push runs, so a re-run after a partial failure finds the PR instead of opening a second one.
- The `OpenPull` claim in `packages/fabrika-cli/src/lane/prove.ts` stays the proof of a single-issue
  `DONE`. It is unchanged; the fold is what makes it reachable on every push that lands.
- `claude-plugins/fabrika/skills/build/SKILL.md` §5, which orders push and then PR-open as two
  steps, becomes one step.

**Binding constraints.**

- No stranded-remote-branch cleanup rule is added. No cleanup failure has recurred, so under the
  ruling's lens it earns none.
- No new gate and no new token is added. The fold removes the window; it does not add a check for it.
- No resume path recognises or adopts a pushed branch that has no PR.

## Consequences

- A builder that dies after the folded step returns has an open PR, so its lane proves `DONE`
  instead of parking on a human.
- The window does not vanish entirely: a death after the ref moves and before the create lands still
  strands a branch. It shrinks from a whole agent turn (writing the PR body, then a second command)
  to the inside of one verb, and a re-run of the verb finishes the create rather than duplicating it.
- A branch stranded before this lands, or in the narrowed window after it, is cleared by hand as it
  is today. That is the cost of adding no cleanup rule, accepted until such a failure recurs.
- The fold itself is implementation work tracked in
  [#10015](https://github.com/kamp-us/phoenix/issues/10015). This record changes no verb behaviour.

## Records

no vocabulary impact
