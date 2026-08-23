---
id: 0327
title: A `ship` FAIL routes to `build` in the single-issue lane, and a base-drift stop parks
status: accepted
date: 2026-08-21
tags: [fabrika, lane, pipeline, ship, state-machine]
---

# 0327 — A `ship` FAIL routes to `build` in the single-issue lane, and a base-drift stop parks

**What this decides:** in the single-issue lane machine, a shipper FAIL sends the lane back to
`build`, not `review`; and a shipper stopping because the head is behind its base parks with a named
cause instead of failing at all.

## Context

ADR [0317](0317-ui-lane-carries-its-own-shells.md) §"Why `ISSUE.FAIL` at `ship` routes back to
`review`" moved the single-issue coder template's retry arm from `build` to `review`. Its premise
was that a `ship` FAIL means "a green PR refused for a missing verdict", where `build` has nothing
to repair.

That premise stopped holding. The shipper's routing terminals (#6002) send a missing-verdict refusal
to `ROUTED-REVIEW`, and in
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts)'s
`SHELL_VOCABULARIES` that token maps to `BLOCKED`, not `FAIL`. Exactly two shipper tokens still map
to `FAIL`: `ROUTED-REPAIR` and `EJECTED`. Both name a repair, and `build` is the only state owning a
verb that can move a branch.

So the arm 0317 wrote now sends every shipper FAIL to a stage that cannot act on it. The reviewer
re-verdicts a byte-identical head, exits PASS, and hands the lane straight back to `ship`, which
stops on the same thing. Each lap spends a repair retry. On 2026-08-20 PT that froze three lanes —
6759 (#6801), 6374 (#6894) and 6226 (#6916) — none of which had a defect in it. Lane 6226 was one
commit behind, so the trigger is any drift at all, and a control-plane-gated PR cannot avoid drift:
the human approval it waits on outlasts main standing still.

The same template already answered this question the other way one state along. `ship:queued`'s
`ISSUE.FAIL` targets `build`, written that way by ADR
[0313](0313-a-queue-dwell-is-a-wait-not-a-park.md), which "routes an ejection back into `build`".
`review`'s FAIL arm targets `build` too. `ship` was the outlier.

The second half is the drift stop itself, which should never have reached a FAIL arm.
`ship cp-approval` emits `stop` / `awaiting-approval` on a head behind its base; the drift is a
diagnostic line, not a second outcome
([`packages/fabrika-cli/src/ship/cp-approval-verb.ts`](../packages/fabrika-cli/src/ship/cp-approval-verb.ts)).
Three shippers read `claude-plugins/fabrika/skills/ship/SKILL.md` §2's rebase-first sentence over its
terminal sentence and reported `ROUTED-REPAIR`. ADR 0313 drew the line that reading crosses:
`retries` is "the lane failed and is spending a chance to fix itself", `waits` is "a lane that did
nothing wrong". Drift is the second kind.

This amends 0317 §"Why `ISSUE.FAIL` at `ship` routes back to `review`" in part. The rest of 0317
stands, including the UI shells, the `build:ui` / `review:ui` states, and that section's own claim
about the **epic tail**, which is a different case and unchanged.

## Decision

**In the single-issue coder template, `ship`'s `ISSUE.FAIL` retry arm targets `build`; and a
`ship cp-approval` stop carrying a base-drift notice is reported as `AWAITING-CP-APPROVAL` with
`--cause head-behind-base`, never as `ROUTED-REPAIR`.**

- [`packages/fabrika-cli/src/lane/templates/coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json)'s
  `ship` state routes `ISSUE.FAIL` to `build`. The `retriesRemaining` guard, the `incrementRetries`
  action and the `frozen` fallthrough are unchanged, so a spent budget still freezes.
- The epic tail keeps `review`. [`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts)
  builds a tail region with no `build` state at all — its repair round happens outside the machine
  and the next verdict is another review — so `review` is the only retry arm that region can have.
  Retargeting it would break that design, not fix it.
- `PARK_CAUSES` in `report.ts` carries `head-behind-base`. It owes no `KNOWN_PARKS` row: clearing it
  needs a verb that merges the base into the head and `build` ships none, so `classifyPark` answers
  `Novel` **naming the cause** and routes to a human. A cause row alone is legal wherever no remedy
  verb exists; the pairing rule binds the other direction.
- `ship`'s SKILL §2 states which of its two sentences wins: the terminal is `AWAITING-CP-APPROVAL`,
  which maps to `BLOCKED`, and a park spends neither budget.

## Consequences

- A shipper FAIL now reaches the one stage that can act on it, and a lane can no longer burn its
  retry budget on laps that move nothing.
- A drift stop costs no budget at all, so a cp-gated PR waiting on a human no longer freezes for
  waiting. Unfreezing one cost a founder `build clear` plus a human `UNBLOCKED` (ADR
  [0312](0312-event-anchored-retry-budget.md), exit 36).
- A `head-behind-base` park still spends a person until somebody writes the remedy verb and its
  `KNOWN_PARKS` row. That is the trade taken here: naming the cause is what makes the park readable
  enough for that row to be writable later.
- `ISSUE.BLOCKED` targets are untouched — [#6503](https://github.com/kamp-us/phoenix/issues/6503)
  still owns the three-meanings collapse onto `human:cp-approval`, and
  [#6380](https://github.com/kamp-us/phoenix/issues/6380) still owns the exit back out of that park.
- 0317's body is not rewritten. Its status line carries `amended-in-part by 0327` and its section
  heading names the scope it still holds for, per the repo's ADR-immutability convention.
