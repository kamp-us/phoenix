---
id: 0127
title: One shared cold-start readiness primitive for the integration harness
status: accepted
date: 2026-07-03
tags: [testing, infra, reliability]
---

# 0127 — One shared cold-start readiness primitive for the integration harness

## Context

The integration suite deploys the real phoenix stack to real remote Cloudflare under a per-file
isolated stage (ADR 0082) — ~24 brand-new `*.workers.dev` hostnames + their DOs + D1 replicas per
run. Every probe's FIRST request against a freshly-deployed stage can therefore hit a cold edge or
a cold worker before the route (or the DO, or the D1 read replica) has propagated. That window is
not a failure — it surfaces as an HTML edge-placeholder-404 ("There is nothing here yet"), a 503
cold-start `LIVE_UNAVAILABLE` envelope, or a transient non-200 — but if a probe treats it as one,
it flakes the suite and taxes every backlog drain.

We fixed this **one probe at a time**, and the point-fixes drifted into parallel copies of the same
idea across two files:

- **#1689** taught the `/fate/live` open to ride the cold window: `req` converts the CF
  placeholder-404 into a typed `CloudflarePlaceholder404Error`, and a bounded `pollUntilReady`
  budget rides *only* that typed throw (and a not-ready response) out while every other throw
  fast-fails.
- **#1717** re-taught the *same* tolerance to `h.signUp` (`/api/auth/sign-up/email`, 22 user-minting
  call sites) — the auth-signup sibling of the same gap, wired as `postAuthReady`.
- The `/api/health` worker-ready probe (`awaitWorkerReady`) and the `/fate/live`/`POST /fate` warm
  probes (`warmLiveDO`, `warmFateRead`) each grew their **own** tagged retry sentinel
  (`WorkerNotReady`, `LiveDONotReady`, `FateReadNotReady`) + a bespoke `Schedule.spaced("2 seconds")`
  loop, and `warmLiveDO` even carried a **second** placeholder detector (`isLiveWarmupNotReady`, a
  content-type test) parallel to `isCloudflarePlaceholder404`.

The evidence that this is a recurring family, not a one-off, is decisive: **three distinct probes
hit the same cold-start signature across two lanes** — `/fate/live` (#1689; the product lane hit it
3× on #1685 and once on #1659 pre-fix), `/api/auth/sign-up/email` (#1717), and `/api/health`
observed on #1720's CI (`WorkerNotReady`, `fts-backfill.test.ts`). Each recurrence was rediscovered
*as a flake* and closed with a fresh point-patch. Point-fixing drifts precisely because the
tolerance lives in N places: the next cold probe is a place nobody taught yet, so it flakes, gets
diagnosed from scratch, and grows an (N+1)th near-copy. That is O(N) rediscovery of one fact.

This is an engineering-led infra decision (ADR 0078): the integration harness is test/CI
substrate, not product surface.

## Decision

**Unify the harness's cold-start readiness gates into ONE shared primitive** — `awaitEdgeReady`
(`apps/web/tests/integration/_edge-ready.ts`) — and route **every** probe through it. The primitive
is the #1689/#1717 mechanism, generalized and made the single home:

- ONE typed placeholder-404 signal (`CloudflarePlaceholder404Error` + `isCloudflarePlaceholder404` +
  `isCloudflarePlaceholder404Error`) and ONE `edgeFetch` that raises it, shared by the harness `req`
  loop and the deploy-time warm probes.
- ONE bounded readiness poll, `awaitEdgeReady(send, ready, {deadlineMs, pollMs})`, parameterized by a
  per-probe `ready` predicate (which may be async — the `/api/health` probe inspects the JSON body).

Every caller supplies only its own `ready` predicate; the primitive owns the uniform tolerance:

| Probe | Path | `ready` predicate |
|---|---|---|
| `openSse` | `/fate/live` (SSE open) | 200 + `text/event-stream` |
| `liveControl` | `/fate/live` (control POST) | status ≠ 503 |
| `h.signUp` / sign-in | `/api/auth/sign-up/email` | `() => true` (only a thrown placeholder retries) |
| `awaitWorkerReady` | `/api/health` | 200 + body `{status:"ok"}` (async) |
| `warmLiveDO` | `/fate/live` (warm) | 200 **or** a terminal worker JSON 4xx |
| `warmFateRead` | `POST /fate` (warm) | 200 |

The tolerance is **scoped, not blanket** — the invariant every point-fix guaranteed, now held once in
the primitive: **only** a thrown `CloudflarePlaceholder404Error` or a `!ready(res)` response rides the
budget; **every other throw escapes immediately, unretried**. So a real error fast-fails at each
caller — the 422-already-exists → sign-in fallback, a genuine 4xx/validation error, an abort/timeout,
and a terminal worker JSON 4xx all surface promptly; a genuinely-dead worker still DIES with a clear
message after the bound (`awaitWorkerReady` via `Effect.promise`). On a not-ready response exhausting
the deadline the primitive returns the last response (the #1060 no-early-stop guarantee), so a
caller's own assertion still reports the truth.

The per-probe tagged sentinels (`WorkerNotReady`/`LiveDONotReady`/`FateReadNotReady`), their bespoke
`Schedule.spaced` loops, and the duplicate `pollUntilReady` copy are **retired into the primitive**.
The two point-fix test files (`_fate-live-readiness.unit.test.ts` #1690,
`_auth-signup-readiness.unit.test.ts` #1720) fold into one `_edge-ready.unit.test.ts` re-expressed
over the shared primitive.

## Consequences

- **The next cold probe is one predicate, not a new mechanism.** Adding a readiness gate for a future
  route is `awaitEdgeReady(() => edgeFetch(url), <ready>)` — the cold-window tolerance and its
  fast-fail scoping come for free. The O(N)-rediscovery treadmill is closed: there is now one place to
  read, one place to fix, one place to test.
- **The fast-fail invariant is enforced in one audited spot.** Because "only the placeholder-404 /
  not-ready signal rides the budget" lives once, a review of that single function certifies it for
  every probe, instead of re-verifying N near-copies.
- **Blast radius: every warmup path changed at once.** This touches `_harness.ts`, `_integration.ts`,
  and `_global-setup.ts` together — the risk the "stay point-wise" option traded against. It is bounded
  by behavior-preservation: `/fate/live` cross-role SSE, signup user-minting, `/api/health` worker-ready,
  and the two warm probes behave identically, pinned by the consolidated unit tests plus the real-D1
  integration suite and the (now blocking) flows-e2e in CI.
- **`awaitWorkerReady` no longer needs an `HttpClient`.** It rides `awaitEdgeReady` over a bare `fetch`,
  so it drops the runtime `HttpClient` requirement (`Effect<void, never, never>`), simplifying both the
  per-file and shared-stage (`_global-setup.ts`) deploy paths. Exhaustion is still a hard defect (die).
- **One minor behavior change, deliberately accepted.** `warmLiveDO` previously retried a raw
  transport throw during its warm-open; the primitive fast-fails a non-placeholder throw, so such a
  blip now skips the (best-effort, swallowed) warm rather than retrying it. The real safety net is
  unchanged: the asserting test's first `/fate/live` open rides the same `awaitEdgeReady` budget.
- **Supersedes the point-fix strategy of #1689 / #1717** (not those PRs' correctness — their mechanism
  *is* the primitive now). The recurrence question the triage issue posed is closed: generalize, done.
