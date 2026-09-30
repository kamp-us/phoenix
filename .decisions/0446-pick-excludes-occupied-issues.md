---
id: 0446
title: Build pick reads occupancy off live claims and open linking PRs, never off a label
status: accepted
date: 2026-09-30
tags: [fabrika, pipeline, build, claims]
---

# 0446 — Build pick reads occupancy off live claims and open linking PRs, never off a label

**What this decides:** `ready-for:agent` says who may work an issue, not whether someone already
is. To stop two builders landing on one issue, `build pick` leaves out any issue that has a live
claim or an open PR linking it, and says why in its excluded list. No new label is added. Repair of
work already in flight still goes through its own by-number routes.

## Context

A driver filled builder seats from `gh issue list` filtered to `ready-for:agent` and spawned a
second builder on [#8550](https://github.com/kamp-us/phoenix/issues/8550) while another lane was
mid-review on it with [PR #8561](https://github.com/kamp-us/phoenix/pull/8561) open. The first
lane's claim had been released between stages, so the second `build claim` won and posted a marker,
which was then deleted by hand. In the same overlap the #8561 owner's repair claim disappeared; which
deletion removed which marker was never established. Issue
[#8566](https://github.com/kamp-us/phoenix/issues/8566) asked which authoritative read a driver must
take before dispatch.

`ready-for:agent` is an audience label ([ADR 0254](0254-ready-for-gap-closes-lazily-at-triage-time.md))
and stays on from triage through build, so a label-only read cannot tell free work from worked
work. `build pick` filters on status, audience, assignment, acceptance criteria and the `blocked_by`
graph, and on nothing that says an issue is occupied.

Ruling, 2026-09-10 PT, recorded on
[#8566, comment 5625044369](https://github.com/kamp-us/phoenix/issues/8566#issuecomment-5625044369)
by the EA session under the founder's standing ruling that engine mechanics are the driver's to
decide ([#8807](https://github.com/kamp-us/phoenix/issues/8807) R4.1), verbatim:

> **Ruled:** Extend the existing reads rather than mint a label: have `build pick` exclude any
> candidate with a live claim marker or an open linking PR, naming the reason in its excluded list,
> and leave repair reachable through `build resume-child`. Keep exact-token claim cleanup.

This record writes that ruling down, per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

## Decision

**Occupancy is a read `build pick` takes off the board, never a label: a candidate with a live
claim marker or an open linking PR leaves the pool with its reason named.**

- **Live claim.** A candidate carrying a live build claim marker, the one `build claim` writes and
  `build claimants` lists, is excluded from the pool.
- **Open linking PR.** A candidate that an open PR links is excluded. A PR links an issue the way the
  repair claim already reads it: a closing keyword or `Part of #<n>` in the PR body
  ([`target.ts`](../packages/fabrika-cli/src/build/target.ts), `resolveAdmissionSubject`).
- **Reason named.** Each exclusion lands in `build pick`'s `excluded` histogram under its own
  reason, beside `audience-not-agent`, `no-acceptance-criteria`, `unreadable` and `blocked`.
- **Unavailable reads.** An occupancy read that fails is not "free". It follows the rule the pool
  already applies to an unreadable `blocked_by` graph ([ADR 0301](0301-blocked-by-graph-is-the-carrier.md),
  [ADR 0092](0092-gates-fail-closed-on-zero-scope.md)): the candidate is excluded as `unreadable`,
  never ranked as if it were unoccupied.
- **Epic-child verdicts.** These stay where they are. `build claim` already refuses a fresh claim on
  a child with a standing range verdict (exit `31`), and that gate is unchanged.
- **Repair stays reachable.** The exclusion shrinks the pool and nothing else. A PR repair enters by
  PR number through `build claim <pr> --issue <n>`, and an epic child repair enters through
  `build resume-child`. Neither route reads the pool, so neither is barred by it.

**Why this stops the #8550 shape without locking work out forever.** A pool-sourced driver never
sees an issue that still carries a live claim, or that an open PR still links, which was the state
#8550 was in. Both signals end when the work does. Closing an abandoned PR drops the link, and the
issue returns to the pool. A dead session's claim leaves by the succession routes that already
exist: a board-attested `build adopt` then `build release`
([ADR 0295](0295-board-attested-claim-succession.md)), or the budget-proved retraction of
[ADR 0373](0373-shell-budget-claim-retraction.md). `build claims stale` lists the candidates.

**Binding constraints.**

- No occupancy label. `ready-for:agent` stays an audience label and is never read as occupancy.
- Claim cleanup stays exact-token. `build release` retracts only markers carrying the caller's own
  token and refuses another lane's; a foreign claim leaves only through `build adopt`, which names
  the session it succeeds. Nothing deletes a claim marker by hand or by pattern.

## Consequences

**A driver that dispatches from `build pick` cannot double-book an issue** that is claimed or has a
PR open against it, and the `excluded` histogram says how many were held back for that reason.

**A driver that dispatches off a label read is not covered.** The #8550 driver used
`gh issue list`, not `build pick`, and this ruling puts the bar in the pool only. `build claim` on
a named number still wins when no live claim stands, open linking PR or not.

**Pool reads cost more.** Each candidate now needs its claim markers and its linking PRs read,
bounded by the same `--limit` walk that bounds the `blocked_by` read.

## Records

- Transcribes the ruling on
  [#8566, comment 5625044369](https://github.com/kamp-us/phoenix/issues/8566#issuecomment-5625044369),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The implementation lives in `build pick`
  ([`pick-verb.ts`](../packages/fabrika-cli/src/build/pick-verb.ts)) and step 1 of
  [`claude-plugins/fabrika/skills/build/SKILL.md`](../claude-plugins/fabrika/skills/build/SKILL.md),
  and is filed as [#10298](https://github.com/kamp-us/phoenix/issues/10298).

Vocabulary impact: none coined.

**Left open.** The ruling does not say whether `build claim` itself should refuse a fresh claim on
an issue an open PR links, which is what would close the by-number and label-read routes above.
That is filed for a ruling as [#10299](https://github.com/kamp-us/phoenix/issues/10299), not
decided here.
