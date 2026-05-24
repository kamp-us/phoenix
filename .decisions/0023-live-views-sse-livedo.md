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
- The SSE token rides the `liveUrl` query string (`EventSource` can't set
  headers), validated with `Pasaport.validateSession` at connect.
- Adds a `LIVE_DO` binding and a `new_sqlite_classes` migration to
  `wrangler.jsonc`. Subscriber rows live in DO storage; `generation`/`revision`
  + a 60s alarm prune stale rows; a per-topic event log gives `lastEventId`
  replay.

WebSocket + DO hibernation is the deferred scale escape hatch behind the same
topology, not part of this decision.

## Consequences

- **Easier:** a view goes live by swapping `useView` → `useLiveView`;
  connection membership is server-driven (one publish updates all clients).
- **Cost:** operating a Durable Object — the **first in the repo**. No
  server-side `changed`-path re-resolution (clients mask the inline data);
  lossless reconnect depends on the per-topic event log.
- Amends the DO-deferral stance of [0009](0009-d1-direct-defer-dos-and-workflows.md);
  the Cloudflare Workflows / outbox bans there are untouched.
- See `.patterns/fate-live-views.md`.
