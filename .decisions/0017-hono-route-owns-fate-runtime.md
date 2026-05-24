---
id: 0017
title: The Hono route owns and disposes the per-request fate runtime
status: accepted
date: 2026-05-23
tags: [fate, effect, runtime, worker]
---

# 0017 — The Hono route owns and disposes the per-request fate runtime

## Context

Resolvers run through a per-request `ManagedRuntime` carrying session, env,
and request context (the same shape the GraphQL handler built). fate's
`createFateServer({context})` factory runs once per request but exposes no
post-request teardown hook, so building the runtime inside `context` would
leak one `ManagedRuntime` per request.

## Decision

The Hono `/fate` route owns the runtime. It validates the session, builds the
`ManagedRuntime` with that session baked into the `Auth` layer, passes it to
fate via `adapterContext`, and disposes it in a `finally` through
`executionCtx.waitUntil`. fate's `context` factory just reads `adapterContext`.

The `/fate/live` route builds no runtime — the live Durable Object relays
inline-resolved payloads and does no database work (see [0023](0023-live-views-sse-livedo.md)).

## Consequences

- **Easier:** deterministic disposal, mirroring the old GraphQL try/finally;
  no leaked runtimes.
- **Harder:** runtime construction lives in the route rather than the server
  config — slightly more wiring at the mount point.
- See [fate-server-wiring.md](../.patterns/fate-server-wiring.md).
