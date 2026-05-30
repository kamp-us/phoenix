---
id: 0014
title: Drizzle service exposes `run`/`batch` as bound methods on the service value
status: accepted
date: 2026-05-17
tags: [backend, effect, drizzle, persistence, api-design]
supersedes-section-of: 0011
---

# 0014 — Drizzle service exposes `run`/`batch` as bound methods on the service value

## Context

[0011](0011-drizzle-context-service.md) put `Drizzle` access behind a `Context.Service<Drizzle, DrizzleDb>` whose value was the singleton drizzle builder, with **callback statics on the Tag class**: `Drizzle.run((db) => ...)` and `Drizzle.batch((db) => [...])`. Each static internally yielded `Drizzle` and wrapped the promise.

That shape held under early ports but degraded as features moved over. The failure mode:

- **`R` channel pollution.** Every method that yielded `Drizzle.run(...)` inferred `Drizzle` into its `R` channel — `Effect<A, E, Drizzle>`. The dep bled out of the layer body and into resolvers, into tests, into every composition site. Service method types lied about their dependencies.
- **Parallel API surface to paper over (1).** To recover `R = never`, services wrote closure-captured `tryDb` wrappers at layer build that yielded `Drizzle` once and reused a captured `db` directly. So every feature service grew its own `tryDb` / `runDb` / `batchDb` shadow API doing the same job as the static — three call patterns coexisting (`Drizzle.run` static, the closure wrapper, raw `Effect.tryPromise` inside batch escape hatches).
- **Wrong home for the error wrap.** With `tryDb` in every feature, the `DrizzleError` catch lived in N places — every feature service had to remember to construct it. The "single search target" promise of 0011 was already broken.

The destructure-at-build wrapper that every feature reinvented was the actual API the foundation should expose. The static-on-class shape was the wrong default.

## Decision

`Drizzle`'s Tag value is a `DrizzleAccess` record with two **bound methods**, not statics on the Tag class:

```ts
export interface DrizzleAccess {
  readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A, DrizzleError>;
  readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
    fn: (db: DrizzleDb) => T,
  ) => Effect.Effect<BatchResult<T>, DrizzleError>;
}

export class Drizzle extends Context.Service<Drizzle, DrizzleAccess>()("@phoenix/Drizzle") {}
```

The `Drizzle` class is identity-only. No statics, no helpers. The only API surface is the destructured methods on the yielded service value:

```ts
export const SozlukLive = Layer.effect(Sozluk)(
  Effect.gen(function*() {
    const {run, batch} = yield* Drizzle;  // once, at layer build
    // ... methods use `run` / `batch` directly
  }),
);
```

The `DrizzleError` catch lives in **exactly one place** — `DrizzleLive`'s body. Feature services never construct `DrizzleError` and never write `Effect.tryPromise` for db calls.

### What this changes vs 0011

- 0011's "callback statics on the `Drizzle` service" → callback **methods on the `Drizzle` service value**.
- 0011's `Drizzle.run((db) => ...)` call site → `run((db) => ...)` (where `run` was destructured at layer build).
- 0011's "single search target" — still holds, but the search target shifted from `Drizzle.run` / `Drizzle.batch` to `yield* Drizzle` in layer bodies and `(db) =>` callback shape at call sites.

The architectural decision from 0011 — wrap drizzle behind `Context.Service` rather than no-wrap or prototype-patch — stands. This decision is about API surface within that wrap.

## Consequences

**Easier:**

- **Service method types are honest.** `Effect<A, E, never>` for db-only methods; `Effect<A, E, Vote>` only when the method genuinely depends on another service. The `R` channel reflects real deps.
- **One canonical API.** No `tryDb` / `runDb` shadow wrappers; no choice for the author about which form to use. Layer build destructures once; methods use the bound functions.
- **One home for the error wrap.** `DrizzleError` is constructed in `DrizzleLive` only. Feature services have nothing to remember.
- **No parallel surface.** Removing the static eliminates the temptation to mix call patterns within a single service.

**Harder / costlier:**

- **One-time mechanical reshape.** Every feature service that landed under 0011's static-shape had to swap `Drizzle.run(...)` for the destructured form. Done in the task 4 corrective commit (`071b315`).
- **Slight lexical overhead at the top of every layer body.** `const {run, batch} = yield* Drizzle;` instead of an implicit static call. Worth it — explicit dep capture is exactly what makes `R = never` work.

**Now banned:**

- `Drizzle.run(...)` or `Drizzle.batch(...)` as static method calls (the static no longer exists; the grep returns zero hits in `apps/web/worker/features/` and `apps/web/worker/db/Drizzle.test.ts`).
- Per-feature `tryDb` / `runDb` / `batchDb` closure wrappers — the foundation now exposes the same shape.
- Constructing `DrizzleError` outside `DrizzleLive` — the catch lives in exactly one place.

**Testing:** the test layer for `Drizzle` builds a `DrizzleAccess` record over a fake `DrizzleDb` and provides it via `Layer.succeed(Drizzle, makeAccess(fakeDb))`. Tests destructure `{run, batch}` inside `Effect.gen` and exercise the wrap. See `apps/web/worker/db/Drizzle.test.ts` for the canonical shape and [.patterns/effect-testing.md](../.patterns/effect-testing.md) for the rationale.

**Consistency check with [0013](0013-validation-in-service-methods.md):** unchanged. Input validation still lives inside service method bodies as `Effect.fn` helpers / closure validators; this decision only relocates the db-access wrap. Validation predates the db touch in any method that does both — the call order is `validate → run → batch`.

**Patterns:** see [.patterns/feature-services.md](../.patterns/feature-services.md) for the `Drizzle` service shape and call-site idioms (single-query, atomic batch, raw SQL escape), and [.patterns/effect-testing.md](../.patterns/effect-testing.md) for the test layer shape.
