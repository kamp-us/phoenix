---
id: 0011
title: Drizzle access via `Context.Service` with `run`/`batch` callbacks
status: superseded-in-part by 0014
superseded-section-by: 0014
date: 2026-05-17
tags: [backend, effect, drizzle, persistence]
---

# 0011 — Drizzle access via `Context.Service` with `run`/`batch` callbacks

> **Note:** The "decision" recorded below was partially superseded by [0014](./0014-drizzle-run-batch-as-service-methods.md). Read 0014 before applying any code from this ADR.

## Context

Under [0010](0010-effect-context-service-backend.md), every drizzle call sits behind an Effect-based service. The mechanism for that wrap is a real design call. Three candidates considered:

1. **No wrap.** `Drizzle` holds the singleton `db`; feature code writes `Effect.tryPromise(() => db.foo())` at every call site. Mixed Promise/Effect paradigm leaks into product code.
2. **Prototype patch** (the v3 `@effect/sql-drizzle` technique adapted to v4). Module-augment `drizzle-orm`'s `QueryPromise` to implement `Effectable.Prototype`, making every drizzle query directly yieldable as an Effect. ~70 lines of internal patch code; cleanest ergonomics at call sites; non-local behavior (call site doesn't show the wrap).
3. **Callback statics** on the `Drizzle` service. `Drizzle.run((db) => db.foo())` and `Drizzle.batch((db) => [...])` wrap promises into Effects. Indirection at every call site, but the wrap is explicit and searchable.

The "humans stopped writing code" reframe inverted the ergonomics analysis. For agent-written code, locality, mistake-resistance, searchability, and explicit extension points outweigh lexical brevity. Prototype patching is clever-but-magic; callbacks are explicit-but-verbose. The lexical cost of `(db) =>` is zero for agents.

Also considered and deferred: replacing drizzle entirely with `@effect/sql-d1`. Effect-sql is more native (no wrap needed, automatic per-query spans, reactive queries) but the rewrite cost is large and the migration is already big. See vault grill `2026-05-17-effect-migration.md` post-grill addendum.

## Decision

`Drizzle` is a `Context.Service<Drizzle, DrizzleDb>` whose value is the singleton drizzle builder. All drizzle access goes through two statics on the class:

- **`Drizzle.run((db) => Promise<A>)`** — single statement. Returns `Effect<A, DrizzleError>`. The callback receives the drizzle builder; the static yields the service internally and wraps the promise with `Effect.tryPromise` (object notation).
- **`Drizzle.batch((db) => [stmt1, stmt2, ...])`** — atomic multi-statement write via drizzle's native `db.batch([...])`. Callback returns an unexecuted tuple of drizzle statements; the static wraps `db.batch` in an Effect.

Errors from both paths surface as `DrizzleError extends Data.TaggedError("@phoenix/Drizzle/Error")<{cause: unknown}>`. The resolver wrapper maps `_tag: "@phoenix/Drizzle/Error"` to `INTERNAL_SERVER_ERROR`.

The D1 binding (`env.PHOENIX_DB`) is referenced exactly once — inside `services/Drizzle.ts`. Feature services never touch it directly.

**House rule:** `Effect.tryPromise` always uses object notation (`{try, catch}`) with an explicit tagged-error catch. Single-arg form (`Effect.tryPromise(() => p)`) is treated as if it were `Effect.promise` — banned.

## Consequences

**Easier:**
- Feature code is fully Effect-native at the call site — no inline `Effect.tryPromise`, no `env.PHOENIX_DB` references, no mixed paradigm.
- Atomicity is expressible: a single `Drizzle.batch((db) => [...])` is the atomic unit. Reads-then-writes split naturally — read via `Drizzle.run`, then batch the dependent writes.
- Single search target. `grep "Drizzle.run"` finds every database operation in the codebase; `grep "Drizzle.batch"` finds every atomic write.
- Future hardening (per-query logging, retries, caching) lands on the statics without touching call sites.

**Harder / costlier:**
- `(db) =>` callback indirection at every query site. Lexical noise, but zero cost for agent-written code.
- Asymmetric error story per query — `DrizzleError` is a coarse infrastructure tag. Per-query operation names live in the calling `Effect.fn("Service.method")` span, not in the error.

**Now banned:**
- `Effect.tryPromise(() => p)` (single-arg) — use the object form with explicit `catch`.
- `Effect.promise(...)` — assumes the promise never rejects; defects bypass the `E` channel.
- Direct `env.PHOENIX_DB.*` calls outside `services/Drizzle.ts`.
- Inline `Effect.tryPromise(() => db.foo())` in feature services — use `Drizzle.run` for the single-call case.
- Prototype-patching drizzle's `QueryPromise`. The technique was considered and rejected for agent-written code.

**Testing:** the `Drizzle` service is the trust boundary. Isolation tests cover scope B — smoke + semantics (error flow → `DrizzleError`) + composition (`Effect.all` over multiple `Drizzle.run` calls) + type inference (callback return type flows to Effect success type). ~10-15 tests. Product code that uses `Drizzle.run`/`Drizzle.batch` is tested via integration through miniflare; the wrap behavior is trusted because the isolation tests cover it.

**Patterns:** see `.patterns/feature-services.md` for the canonical `Drizzle` service shape and call-site idioms, `.patterns/effect-testing.md` for the trust-boundary test scope.
