---
id: 0023
title: Live views over SSE, fanned out by the LiveDO Durable Object
status: accepted
date: 2026-05-23
tags: [fate, live, durable-objects, sse]
---

# 0023 — Live views over SSE, fanned out by the LiveDO Durable Object

## Context

We want real-time views (a view stays current without refetching). fate's
built-in live bus is an in-memory `EventEmitter`: a `live.update` reaches only
subscribers in the same Worker isolate, so it cannot fan out across isolates.

[0009](0009-d1-direct-defer-dos-and-workflows.md) deferred all Durable Objects
and named the exact re-introduction trigger: *"Real-time UX becomes a product
requirement → re-introduce a single, scoped DO for WebSocket fan-out."* That
trigger is now met. This ADR fulfills 0009's condition; 0009's D1-direct
decision otherwise stands (D1 remains the canonical store).

## Decision

Live views run over **SSE** — fate's native live client (`EventSource`), no
custom connector and not WebSocket. Cross-isolate fan-out is handled by
**`LiveDO`**, the one Durable Object in phoenix:

- A **connection-role** instance (`connection:<id>`) owns one client's SSE
  stream and subscription list; a **topic-role** instance (`topic:<key>`)
  holds the durable subscriber registry for a topic.
- A **publish-only `LiveEventBus`** forwards `live.*` events to topic DOs,
  which deliver to connection DOs. Mutations publish **inline-resolved**
  `data`/`node` (already resolved for the response), so the DO does no
  database work and needs no Effect runtime.
- The SSE stream authenticates with the **better-auth session cookie**: fate
  opens the `EventSource` with `withCredentials: true`, so the cookie rides the
  `GET` (same-origin); the Worker validates it with `Pasaport.validateSession`
  at connect. No token in the URL, no header.
- Adds a `LIVE_DO` binding and a `new_sqlite_classes` migration to
  `wrangler.jsonc`. Subscriber rows live in DO storage; each row carries the
  connection's `generation`, and a row is pruned only when a *reachable*
  connection DO reports a different current generation (a transport/parse
  failure leaves the row). A 60s alarm probes for orphans the same way. The
  connection `generation` is **persisted in its DO storage** (eviction-proof),
  so it monotonically identifies one stream lifetime — a reconnect after
  eviction always lands on a higher generation than any stale row. v1 resumes
  **live-only** on reconnect; a per-topic event log for `lastEventId` replay is
  a deferred follow-on.

WebSocket + DO hibernation is the deferred scale escape hatch behind the same
topology, not part of this decision.

## Consequences

- **Easier:** a view goes live by swapping `useView` → `useLiveView`;
  connection membership is server-driven (one publish updates all clients).
- **Cost:** operating a Durable Object — the **first in the repo**. No
  server-side `changed`-path re-resolution (clients mask the inline data);
  reconnect resumes live-only in v1 (lossless replay deferred).
- Amends the DO-deferral stance of [0009](0009-d1-direct-defer-dos-and-workflows.md);
  the Cloudflare Workflows / outbox bans there are untouched.
- See [fate-live-views.md](../.patterns/fate-live-views.md).
