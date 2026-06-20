---
id: 0095
title: Bounded cold-start retry at the LiveDO RPC transport seam — the `never` error channel is a type lie
status: accepted
date: 2026-06-20
tags: [fate, live, sse, durable-objects, alchemy, effect, resilience]
---

# 0095 — Cold-start retry at the LiveDO RPC transport seam

## Context

Cloudflare evicts idle Durable Objects, so the **first** `/fate/live` connect or
subscribe for an idle user hits a cold `connection:`/`topic:` DO. This is the
steady-state production path for the app-lifetime global live pin
([ADR 0094](0094-app-lifetime-global-live-pin.md)), which fires on every
authenticated session mount against a `topic:User:<id>` DO that is cold for any
idle user.

The `LiveDO` RPC surface (`live-do.ts` `LiveRpcSurface`) declares every method
`Effect<…, never, never>`. That `never` is a **type lie**: the alchemy stub
(`makeRpcStub`, `alchemy/Cloudflare/Workers/Rpc`) wraps each cross-DO call in
`Effect.tryPromise({catch: … RpcCallError})`, so a real cold-start transport
failure surfaces as an `RpcCallError` in the **failure channel** the static type
erases. The route consumed this unguarded:

- `route.ts` GET connect: `connections.open(…).pipe(Effect.orDie)` — a cold-DO
  transport failure became a **defect → HTTP 500**.
- `route.ts` POST subscribe: a bare `connections.subscribe(…)` with no catch —
  the runtime `RpcCallError` escaped as a platform 500.

A 500 is unrecoverable client-side: the fate native live transport's `add()` does
`open.then(...).catch(err => operations.delete(id))`, so a fatal non-200
**permanently drops the subscription** and EventSource won't reconnect past it. The
prior cures ([#613](https://github.com/kamp-us/phoenix/issues/613),
[#769](https://github.com/kamp-us/phoenix/issues/769)) were **harness-only** — a
warm-retry wrapper in the integration test — leaving the runtime path unhardened
(the "mitigation hiding the root cause" anti-pattern; confirmed by the
[#774](https://github.com/kamp-us/phoenix/issues/774) investigation,
output [#842](https://github.com/kamp-us/phoenix/issues/842)).

## Decision

Make the production path resilient at the **one seam where the runtime transport
error is reachable** — the worker `index.ts` `liveLayer`, where the alchemy stub
method is actually invoked. A new `apps/web/worker/features/fate-live/cold-start-retry.ts`
owns `withColdStartRetry(method, call)`:

- **Bounded retry, transport channel only.** Capped exponential backoff
  `Schedule.both(Schedule.exponential("100 millis"), Schedule.recurs(4))` (5 attempts,
  ~1.5s worst case) absorbs the sub-second warm window. The retry keys on the
  `RpcCallError` `_tag` via `Retry.Options.while`, so a **genuine app error fails
  fast and passes through untouched** — never retried, never masked. The
  `RpcCallError` class is internal to alchemy (off the public export path), so the
  structural `_tag` check is the only available seam. Schedule shape grounds in
  effect-smol `LLMS.md` §"Working with Schedules" (`retryBackoffWithLimit` +
  `retryableOnly`).
- **Truthful error channel.** On exhaustion the surviving transport failure becomes
  a typed `LiveTransportError`. The `LiveConnections` service signatures (`topics.ts`)
  declare it instead of the erased `never`, so the route is **forced** to handle the
  graceful path — a swallowed transport failure is made unrepresentable.
- **Graceful 503, not a defect-500.** The route renders `LiveTransportError` as a
  `liveError("LIVE_UNAVAILABLE", …, 503)` envelope. The global pin retries the whole
  connect on the next mount; a 503 is a transient back-off signal, not a fatal drop.

## Consequences

- A subscribe/connect against a cold topic/connection DO **succeeds** (the retry
  absorbs the warm window) instead of 500-ing and permanently dropping the
  subscription.
- The integration harness' warm-retry wrappers (`openSseWarm`/`liveControlWarm`,
  `apps/web/tests/integration/fate-live.test.ts`) are **removed** — the suite asserts
  directly against the now-resilient production path, proving the fix is real, not
  another harness band-aid (the #774 acceptance criterion).
- The seam choice is `index.ts`, not the route, **because** that is the only place
  the `RpcCallError` is in the failure channel; at the route the service type erases
  it to `never`, so the route cannot catch what its type says doesn't exist.
- A genuine 4xx/app error from the DO is **not** retried as a 503 — the `while`
  predicate confines the retry to the transport tag.
- `publish` (fire-and-forget, swallowed best-effort per ADR 0039) is **out of
  scope**: a cold-start publish failure is acceptably dropped and must not fail the
  committed mutation; only the connect/subscribe request paths are hardened.
