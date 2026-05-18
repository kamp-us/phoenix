---
id: 0010
title: Effect Context.Service architecture for resolver-down backend code
status: accepted
date: 2026-05-17
tags: [backend, effect, architecture]
---

# 0010 — Effect Context.Service architecture for resolver-down backend code

## Context

Today's backend (`apps/web/worker/features/*/module.ts`) is ~3000 LOC of exported `async function`s that take `env`, call `drizzle(env.PHOENIX_DB, {schema})` inline, throw plain `Error` subclasses, and orchestrate multi-aggregate writes with bare `await`. The resolver wrapper at `worker/graphql/resolver.ts` is already Effect-aware via `ManagedRuntime`, but the layer below it (feature modules, readers, Hono admin routes) is fully promise-based.

The mismatch produces concrete pain: `env` is threaded through every call signature; errors are untyped exceptions resolvers handle ad-hoc; multi-aggregate writes have no atomicity story expressible in the type system; tracing is per-await rather than per-operation; tests reach for miniflare even for validation logic because there's no seam below the drizzle call.

The phoenix architecture goal (ADR 0009 d1-direct + collapsed-codebase rationale) was to enable Effect services as design boundaries. The current paradigm split blocks that goal.

## Decision

All resolver-touchable backend code is rewritten in idiomatic Effect.

- **Scope:** "Resolver-down" — every code path reachable from a GraphQL resolver or Hono admin route. Out of scope: `handleAuth` (`/api/auth/*`), `/agents/*`, `seed.ts`, importer scripts.
- **Feature shape:** one `Context.Service` per feature folder (`Sozluk`, `Pano`, `Vote`, `Pasaport`). Methods return `Effect`; errors are `Data.TaggedError` instances in the `E` channel; the resolver wrapper switches on `_tag` to map to wire codes. Reads and writes coexist on the same service.
- **Admin operations:** parallel `<Feature>Admin` services (`SozlukAdmin`, `PanoAdmin`, `PasaportAdmin`) with their own `ManagedRuntime` separate from the GraphQL runtime. Gated by an `AdminAuth` service.
- **Migration is 1:1 in semantics.** Today's async function becomes tomorrow's `Effect.fn` method on a service. No new abstractions, no behavior changes. Wire codes (`extensions.code` strings) preserved identically.
- **DDD aggregate boundaries are explicitly deferred.** "One service per feature" is a faithful port of the current shape, not a long-term commitment. Aggregate-shaped splits (`Term` / `Definition` / `Post` / `Comment` / `User` as separate services) are revisited once the effect-native baseline is stable. See vault grill `2026-05-17-effect-migration.md` for the deferred consideration.

## Consequences

**Easier:**
- Errors are typed in the `E` channel. Resolvers and tests can match on `_tag` without `instanceof` chains.
- `env` is captured once per request at runtime construction; methods don't thread it.
- Tracing is automatic via `Effect.fn("Service.method")` named spans.
- Tests provide layers to swap services or environments declaratively.

**Harder / costlier:**
- Single long-lived migration branch; main moves underneath. Rebase discipline required.
- Stretches of type-check red while a feature is mid-migration. Solo branch — fine, just can't share for unrelated work.
- Layer-composition discipline at runtime construction: `Layer.provide` order matters, `R = never` is the proof the wiring is complete.

**Now banned:**
- Throwing inside `Effect.gen` to fail (becomes a defect, bypasses the `E` channel — use `return yield* new MyError({})`).
- `async function` exports in resolver-reachable code.
- `Effect.tryPromise` single-arg form. Object notation `{try, catch}` always, with an explicit tagged-error catch.
- `env.PHOENIX_DB` references outside `services/Drizzle.ts`. The D1 binding never leaves that service.

**Migration cost:** ~3000 LOC of feature code rewritten; ~27 integration tests rewired to provide layers. Single PR, granular commits per feature (errors → service def → live layer → resolver flip → tests → delete old module). Order: Drizzle infra → Pasaport → Vote → Sozluk → Pano.

**Patterns:** see `.patterns/index.md` for the load-bearing references — `effect-context-service.md`, `feature-services.md`, `effect-layer-composition.md`, `effect-errors.md`, `effect-error-operators.md`, `effect-fn-tracing.md`, `effect-testing.md`, `effect-schema-validation.md`.
