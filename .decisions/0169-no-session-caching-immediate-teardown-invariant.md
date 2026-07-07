---
id: 0169
title: "No session caching — immediate session teardown is an invariant; a deleted/logged-out/revoked session must stop authenticating at once, never after a TTL. The session-perf floor is owned by Smart Placement ([0168](0168-d1-region-strategy-smart-placement-first.md)), not by trading session freshness"
status: accepted
date: 2026-07-06
tags: [security, auth, session, performance]
---

# 0169 — No Session Caching: Immediate Teardown Is an Invariant

## Context

Every authenticated `/fate` and `/fate/live` request pays a **2-query D1 session
validation** on the hot path ([#2274](https://github.com/kamp-us/phoenix/issues/2274)).
The proposed fix ([PR #2263](https://github.com/kamp-us/phoenix/pull/2263)) was
better-auth's `session.cookieCache`: serve the validated session out of a signed cookie
for a `maxAge` TTL, so requests inside the window take **zero D1 trips** to authenticate.

An adversarial staleness review of that PR found the load-bearing problem. `cookieCache`
opens a window of up to one TTL in which a session that has been **deleted, logged out, or
revoked still authenticates** — because within the window no D1 re-check happens, so the
server never learns the identity is gone. That is not capability staleness (a stale
role/karma/ban/kefil value feeding a gated decision); it is an **identity-continuity
hole** — a torn-down identity that keeps passing auth. It directly breaks the repo's hard,
**tested** immediate-teardown invariant: the account-deletion integration test
([`apps/web/tests/integration/account-deletion.test.ts`](../apps/web/tests/integration/account-deletion.test.ts))
asserts that after deletion a `me` read with the pre-deletion cookie returns
`UNAUTHORIZED` — i.e. teardown is **immediate**, not eventual. The anonymize-to-`silinen`
model that test guards is ADR [0097](0097-account-deletion-anonymize-silinen.md); the
per-request session carrier it tears down is `CurrentUser`, provided from the validated
session (ADR [0042](0042-fate-effect-v1-architecture.md)).

The founder ruling resolves the perf-vs-invariant tension by removing the tension, not
splitting it. The [#2274](https://github.com/kamp-us/phoenix/issues/2274) 2-query cost was
expensive **only because it was cross-region**: a distant isolate paid ~70–80ms per D1
round trip against the ENAM primary. **Smart Placement (ADR
[0168](0168-d1-region-strategy-smart-placement-first.md), accepted + merged) collapses
those trips in-region**, so the session validation cost falls with **zero security
tradeoff** — the same strong-consistency, always-fresh session check, just served
in-region. That makes `cookieCache` **redundant for the perf** it was reaching for, while
its ≤TTL auth-teardown hole would still cost us the invariant. (Separately, the other
[#2263](https://github.com/kamp-us/phoenix/pull/2263) lever — better-auth
`experimental.joins` — was dropped for an unrelated drizzle RQB v1/v2 adapter
incompatibility; see [#2286](https://github.com/kamp-us/phoenix/issues/2286).)

## Decision

**Phoenix does NOT cache authenticated sessions. Immediate session teardown is an
invariant: a deleted, logged-out, or revoked session must stop authenticating
immediately — never after a TTL or staleness window.**

Concretely:

- **Reject `cookieCache`.** [PR #2263](https://github.com/kamp-us/phoenix/pull/2263) is
  closed; better-auth `session.cookieCache` is not adopted. No signed-cookie session
  short-circuit that skips the D1 re-check may be introduced.
- **The session-perf floor is owned by Smart Placement**
  ([0168](0168-d1-region-strategy-smart-placement-first.md)), not by trading session
  freshness. The perf concern of [#2274](https://github.com/kamp-us/phoenix/issues/2274)
  is addressed by collapsing the D1 trips in-region, keeping every authenticating request
  a fresh, strongly-consistent D1 check.
- **Every authenticated request revalidates the session against the source of truth.**
  There is no TTL window during which a torn-down identity is treated as live.

## Alternatives considered

- **Accept a short (e.g. 60s) revocation window and relax the account-deletion
  invariant/test.** Rejected. This trades a **hard security invariant** — immediate
  identity-continuity teardown — for a perf win that Smart Placement
  ([0168](0168-d1-region-strategy-smart-placement-first.md)) already delivers for free and
  with no consistency cost. Weakening a tested invariant to buy latency we can buy without
  it is a bad trade; the window is exactly the identity-continuity hole, not an acceptable
  freshness lag.

## Consequences

- **`account-deletion.test` and the immediate-teardown invariant stay as-is.** Neither the
  integration test
  ([`apps/web/tests/integration/account-deletion.test.ts`](../apps/web/tests/integration/account-deletion.test.ts))
  nor its unit sibling is relaxed. This ADR changes no code or test; it records the ruling
  that keeps them inviolable.
- **THE LESSON — a session-perf/caching review is a two-axis check.** Any future
  session-caching or session-perf review MUST check **both** axes, not one:
  1. **Capability staleness** — do gated decisions (role, karma, ban, kefil) read a value
     that a cache could serve stale?
  2. **Identity-continuity teardown** — does delete / logout / revoke stop authenticating
     **immediately**, or does a cache keep a torn-down identity alive for up to a TTL?

  The first [#2263](https://github.com/kamp-us/phoenix/pull/2263) review scoped only axis
  (1) and **missed** axis (2); the account-deletion test is what caught it. Folding this
  two-axis check into the session-perf review guidance / the staleness gate is a candidate
  follow-up (to be filed via `report`), so the catch lives in the process, not only in one
  test.
- **Re-proposing session caching requires a fresh threat model on identity-continuity
  teardown**, not just a capability-staleness argument. A caching proposal that reasons
  only about role/karma freshness is incomplete on its face.
- **[#2274](https://github.com/kamp-us/phoenix/issues/2274) stays open** pending
  production validation of Smart Placement ([0168](0168-d1-region-strategy-smart-placement-first.md))
  as the perf lever; it is not closed by adopting a cache.

## Vocabulary impact

Two axes are named here as a durable review lens: **capability staleness** (a cached
gated value — role/karma/ban/kefil) vs **identity-continuity teardown** (delete/logout/
revoke must stop authenticating immediately). These sharpen an existing concept
(session freshness) into a two-axis distinction rather than coining a wholly new domain
noun; they are recorded in this ADR as the canonical framing for future session-caching
reviews. No `.glossary/TERMS.md` row is added now — if the two-axis lens is folded into the
staleness-gate guidance as the follow-up above, surface the terms via `/glossary` at that
point.

## Relationship to prior decisions

- **ADR [0168](0168-d1-region-strategy-smart-placement-first.md)** — Smart Placement as
  the D1 region-strategy perf lever; it owns the session-validation cost this ADR declines
  to solve with caching.
- **ADR [0097](0097-account-deletion-anonymize-silinen.md)** — account deletion =
  anonymize-to-`silinen`; the immediate-teardown invariant is what its integration test
  enforces.
- **ADR [0042](0042-fate-effect-v1-architecture.md)** — `CurrentUser` is the per-request
  session carrier provided from the validated session; "revalidate every request" is a
  statement about how that carrier is populated.
- **[#2263](https://github.com/kamp-us/phoenix/pull/2263)** — the closed `cookieCache` PR
  this ADR rejects.
- **[#2274](https://github.com/kamp-us/phoenix/issues/2274)** — the session-validation
  perf finding, kept open pending 0168 production validation.
- **[#2286](https://github.com/kamp-us/phoenix/issues/2286)** — the drizzle RQB v1/v2
  adapter incompatibility that independently dropped the `experimental.joins` lever from
  #2263.
