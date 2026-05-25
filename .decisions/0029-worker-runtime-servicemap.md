---
id: 0029
title: Dissolve the per-request runtime; worker-level layers and a captured ServiceMap
status: accepted
date: 2026-05-25
tags: [effect, runtime, worker, fate]
---

# 0029 — Dissolve the per-request runtime; worker-level layers and a captured ServiceMap

## Context

Supersedes [0017](0017-hono-route-owns-fate-runtime.md).

[0017](0017-hono-route-owns-fate-runtime.md) had the Hono `/fate` route build a
per-request `ManagedRuntime` and dispose it in `finally`. That was forced by the
old binding model: every binding came from a per-request `env`, so the whole
service graph — `Drizzle`, every feature — was request-scoped, and a runtime per
request was the only place to hang it.

On alchemy that premise is gone. `Cloudflare.D1Connection.bind(PhoenixDb)`
resolves **once per isolate** in the worker's init phase, and the things built on
the bound client are stable for the isolate's life. Only `Auth` (the validated
session) and `RequestContext` genuinely vary per request. fate's async resolver
bridge still needs a handle to run Effects — but a handle, not a lifecycle.

## Decision

No per-request `ManagedRuntime`. The worker provides `Drizzle` (built once in
init from the bound D1 connection) and the feature services (`Sozluk`, `Pano`,
`Vote`, `Pasaport`, `Stats`) as **worker-level layers**.

Per request the `/fate` handler provides only `Auth` + `RequestContext` via
`Effect.provideService`, captures the live service map with
`Effect.services<FateEnv>()`, and hands it to fate through `adapterContext`.
`FateContext` carries a `ServiceMap`, not a `ManagedRuntime`:

```ts
export interface FateContext {
  readonly services: ServiceMap.ServiceMap<FateEnv>;
  readonly request: Request;
}
```

The bridge runs each resolver with
`Effect.runPromiseExit(Effect.provideServices(effect, ctx.services))`. There is
nothing to dispose.

The `Drizzle` `run`/`batch` service contract from
[0014](0014-drizzle-run-batch-as-service-methods.md) is **unchanged** — only its
construction moves, from a per-request `CloudflareEnv` read to a once-per-isolate
build from the bound client. See [.patterns/alchemy-runtime.md](../.patterns/alchemy-runtime.md).

## Consequences

**Easier:**

- **Feature services are isolate singletons.** No per-request allocation; the
  layer graph is built once in init, not on every `/fate` request.
- **Nothing to leak or tear down.** Providing a captured `ServiceMap` and running
  on the default runtime allocates nothing scoped — no `dispose`, no `finally`,
  no `waitUntil` for teardown. Worker-level layers release with the isolate.
- **The bridge changes exactly one line:** `ctx.runtime.runPromiseExit(effect)`
  → `Effect.runPromiseExit(Effect.provideServices(effect, ctx.services))`. The
  helper family (`fateQuery`/`fateList`/`fateMutation`/`fateSource`), the error
  mapping, and the "no `runPromise` in feature code" rule are all untouched.

**Changed:**

- The request/admin two-runtime split from
  [0012](0012-admin-parallel-services.md) becomes **two layer sets over one
  worker** rather than two `ManagedRuntime`s. Both sit on the same worker-level
  `Drizzle`; admin routes provide `AdminAuth` the way `/fate` provides `Auth`.

**Now banned:**

- Building a `ManagedRuntime` inside the `/fate` (or any) route.
- Reading a per-request `env` to construct `Drizzle` or a feature service — they
  are built once, in init, from the bound client.

Verified against effect v4 source: `Effect.services<R>()`,
`Effect.provideServices`, and `Effect.runPromiseExit` exist as used.
