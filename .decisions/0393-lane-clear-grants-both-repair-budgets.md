---
id: 0393
title: A driver's lane clear grants both of a lane's repair budgets
status: accepted
date: 2026-09-15
tags: [fabrika, lane, pipeline, governance]
---

# 0393 — A driver's lane clear grants both of a lane's repair budgets

**What this decides:** `lane clear` now grants the lane's pull request one repair round in the same
act it grants the lane's own, posting the driver's rationale as that grant's dated authorization —
so the builder that reads the PR-side budget proceeds without a founder's `build clear`.

## Context

A lane at its cap has two repair budgets, counted in two logs that never see each other. The lane
machine guards each task with `retries < maxRetries` off the lane's own events; `build verdicts`
folds `capReached` off the FAIL-marker rounds on the pull request. ADR
[0378](0378-driver-seat-on-a-spent-repair-budget.md) gave the driver a seat on the first and left the
second where it was, on the founder's `build clear`.

That made the driver's seat half a seat, and
[#9171](https://github.com/kamp-us/phoenix/issues/9171) reports the run it cost. On lane 8922 / PR
[#9139](https://github.com/kamp-us/phoenix/pull/9139) the driver granted its round with
`lane clear --rationale`, recorded the `UNBLOCKED`, relayed the FAIL and dispatched a builder. The
builder read `build verdicts` at head `7440670` — `rounds: 4`, `capReached: true`, `clearances: []` —
recorded `ISSUE.BLOCKED` with cause `repair-budget-spent` and released its claim without touching the
branch. The lane-side grant bought nothing, and the park it left routes to the driver by
`routeForCause`, which is the one route ADR 0378's own ruling (#8807 R5.1) exists to keep off the
founder's desk. `recipe unpark` refuses it at exit 12, because `repair-budget-spent` carries no
remedy, so the lane ended on a human for a cause nobody said was theirs.

Two shapes answered it — carry the lane-side grant across, or mint a second driver-side PR verb — and
both remove a founder-only gate, so the choice was the founder's rather than a patch's. The founder
ruled the first, verbatim *"yes"*:
[the ruling comment on #9171](https://github.com/kamp-us/phoenix/issues/9171#issuecomment-5688558635).

## Decision

**One `lane clear` grants both budgets, and the rationale is the authorization on both.**

- **The PR half runs first, and the whole act is refused rather than half-made.** Every board read
  and both comment writes happen before the `<TASK>.CLEARED` line is appended, so a PR-side grant
  that cannot be made honourably leaves the lane log byte-identical and a re-run derives the same
  round. The reverse order cannot reconcile: the lane-side budget check refuses a re-run whose own
  grant already landed, which is the wedge #9171 reported.
- **The rationale IS the dated authorization.** `lane clear` posts it on the pull request and the
  `cap-cleared` marker immediately after it, in `build clear`'s own write order and for its reason —
  an interrupted run leaves a quote that grants nobody anything rather than a bare marker a careless
  reader folds as budget. A driver's grant was already reviewable on that line and nowhere else (ADR
  0378); it is now reviewable in two places instead of one.
- **The ACL does not move, and only the founder's document does.** The marker is honoured through
  `build/clearances.ts`'s same four clauses, so the posting account still has to be in
  `.fabrika.jsonc`'s `capClearAuthors` at the PR's base ref and still has to hold `write+` at
  GitHub's live ACL. An account that fails either refuses the whole act at exit `66` with nothing
  posted — a marker it wrote would be void, and a lane-side round recorded beside a void PR-side
  marker is the half-seat this record closes.
- **Each side derives its own round.** The lane's is the round its declared cap freezes at given the
  grants in its log; the PR's is its FAIL-marker round count. One call buys one round on each, and
  neither is typed.
- **`build clear` is unchanged**, and stays the founder's verb for a bare PR-side grant with no lane
  clear behind it. Its `--authorization` document, its clauses and its derivation are untouched.
- **A task with no pull request answers `pr: null` and the lane half proceeds alone.** An epic child
  and a chore lane were ADR 0378's first seat and keep it whole; a child region is excluded by its
  role rather than by a read, because an epic tail's PR closes its landed children and would
  otherwise trace as the child's own.

**This amends ADR 0378 in one clause.** That record states `lane clear` *"is not a widening of
`build clear`… it reads no board, holds no ACL, and posts no marker"*, and all three now read the
other way. What it ruled and this upholds: the round is derived and never typed, every grant is one
countable line, the mandatory rationale is the driver's audit, and a resume with no recorded
`CLEARED` behind it is still refused. ADR [0312](0312-event-anchored-retry-budget.md)'s *"from the
`CLEARED` event and from nothing else"* is unchanged — the PR-side marker is the other reader's copy
of the same grant, not a second source of budget.

## Consequences

A driver clearing a capped lane with a pull request no longer parks on the founder, which is what
#8807 R5.1 ruled and what ADR 0378 could only deliver for lanes that had no PR.

`lane clear` now reads the board, so it takes `--repo`, needs a resolvable target repository on an
issue-keyed lane, and can refuse on codes that were never its own: `20` where two open PRs link the
task's issue, `66` where the account may not clear a round, `5`/`6` where the rationale is headed for
a public pull request carrying a machine-local path or being one. A chore lane still reaches none of
them.

A driver in `capClearAuthors` can now raise a PR's cap with prose it wrote itself. That is the ruled
trade-off, and the weekly machinery review reads the same rationale on both halves.

## Records

No `.glossary/TERMS.md` row: following ADRs 0297, 0312 and 0378, the lane machine's leaf names and
event vocabulary are defined with the machine and the
[`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) skill.

Sources: the founder ruling at
[#9171, comment 5688558635](https://github.com/kamp-us/phoenix/issues/9171#issuecomment-5688558635);
[#9171](https://github.com/kamp-us/phoenix/issues/9171) and the run it reports on
[#9139](https://github.com/kamp-us/phoenix/pull/9139);
ADR [0378](0378-driver-seat-on-a-spent-repair-budget.md), amended in part by this record;
ADRs [0297](0297-frozen-is-a-park-not-an-end.md) and
[0312](0312-event-anchored-retry-budget.md), upheld;
[`packages/fabrika-cli/src/lane/clear-verb.ts`](../packages/fabrika-cli/src/lane/clear-verb.ts),
[`packages/fabrika-cli/src/lane/pr-grant.ts`](../packages/fabrika-cli/src/lane/pr-grant.ts),
[`packages/fabrika-cli/src/build/clearances.ts`](../packages/fabrika-cli/src/build/clearances.ts),
[`packages/fabrika-cli/src/cap-clearance.ts`](../packages/fabrika-cli/src/cap-clearance.ts).
