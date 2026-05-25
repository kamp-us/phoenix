---
id: 0027
title: Drop Hono; HTTP via Effect HttpRouter and HttpApiBuilder
status: accepted
date: 2026-05-25
tags: [http, effect, worker, fate]
---

# 0027 — Drop Hono; HTTP via Effect HttpRouter and HttpApiBuilder

## Context

phoenix routes everything through Hono: `/api/health`, `/api/admin/*`,
`/api/auth/*`, `/fate`, `/fate/live`, and the SPA assets fallback. But
alchemy's worker `fetch` is a native `@effect/platform` value —
`Effect<HttpServerResponse, …, HttpServerRequest>` (see
[0026](0026-adopt-alchemy-effect-infra.md)). There is no Hono in that model;
keeping it means an adapter sitting between Hono and Effect on every request.

The routes themselves are mostly raw-`Request` and SSE, not the JSON-schema
shape Hono's ergonomics are built for: the fate `POST /fate` handler and
better-auth want the raw `Request`; `/fate/live` is an SSE stream. Only a few
endpoints — `/api/health` and the dev-only admin seeders — are typed JSON.

## Decision

Drop Hono. The worker `fetch` is `HttpRouter.toHttpEffect(AppLive)` (from
`effect/unstable/http/HttpRouter`), where `AppLive` is one `Layer` merging two
route styles:

- **Typed JSON** (`/api/health`, `/api/admin/*`) are `HttpApiBuilder` groups —
  schema-decoded params/payloads via
  `HttpApiEndpoint.{get,post}(name, path, {payload, success, error})` over
  `Schema.Struct`/`Schema.Class`, with typed responses for free.
- **Raw `Request` + SSE** (`/fate`, `/api/auth/*`, `/fate/live`) are imperative
  `HttpRouter.add(method, path, handler)` routes. They reach the raw request
  through the `Cloudflare.Request` service and return
  `HttpServerResponse.fromWeb(...)`, which carries the SSE stream through
  verbatim.

Both styles are `Layer`s; they merge into `AppLive`. Because the Workers
runtime has no `FileSystem`, provide an `HttpPlatform` stub (plus `Etag.layer`,
`Path.layer`) or `HttpApiBuilder.layer` won't build. phoenix never serves files
from the worker — the SPA comes from the `assets` binding — so the stub is
always safe.

## Consequences

- **Easier:** one HTTP model end-to-end, no Hono/Effect impedance or adapter;
  typed request/response on the CRUD-ish JSON endpoints; fate's
  `createFateServer` mounts unchanged as a raw-`Request` handler.
- **Cost:** the `HttpPlatformStub` boilerplate; two route styles (declarative
  `HttpApi` + imperative `HttpRouter`) coexist in one app.
- Asset/worker-first precedence (`runWorkerFirst`) interacts with routing — a
  worker-owned path missing from the asset config is answered by the asset
  server first, and the route never runs. See
  [0030](0030-single-worker-vite-dev.md).
- Part of the alchemy adoption umbrella, [0026](0026-adopt-alchemy-effect-infra.md).
- See [alchemy-http-router.md](../.patterns/alchemy-http-router.md).
