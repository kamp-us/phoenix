---
id: 0039
title: LiveBus Context.Service replaces the AsyncLocalStorage publisher bridge
status: amended-in-part by [0042](0042-fate-effect-v1-architecture.md)
date: 2026-05-31
tags: [fate-live, effect, testing]
---

# 0039 — LiveBus Context.Service replaces the AsyncLocalStorage publisher bridge

## Context

The publish-only live bus (ADR [0023](0023-live-views-sse-livedo.md)/[0037](0037-unified-void-aligned-live-do.md)) is called *synchronously* from inside mutation resolvers — `liveBus.connection("Term.definitions", {id}).appendNode(...)`. The per-request publisher it delegates to (closing over `waitUntil` + the worker-init `LiveTopics` namespace) was made ambient through a Node `AsyncLocalStorage` (`livePublishContext`), bound only in the `/fate` route via `livePublishContext.run(publisher, () => handleRequest(...))`. The bus's internal `publish()` read `getStore()`; no ambient store ⇒ silent no-op.

That ALS was justified by a belief that the publish call site has "no Effect context" (a detached fiber). It is false. Mutation resolvers run inside `Effect.gen` with the full `FateEnv` provided by the bridge (`features/fate/effect.ts` `runEffect`), so the bus can be acquired *in Effect-world* with `yield* LiveBus`. The ALS was hand-rolling a per-request injection that Effect's own context already provides.

The ALS also made the canonical fate bridge tests untestable for live behavior: they drive `fateServer.handleRequest` directly, never wrap it in `livePublishContext.run`, so they bound the publisher **zero** times and every `live.*` call silently no-opped. The framework PR (`umut/alchemy-effect-patterns`) must merge tech-debt-free, so the live-publish path has to be assertable.

Verified while deciding: fate itself never calls the bus's publish methods — it touches the bus only on the subscribe side (`"subscribe" in live` detection + `handleLiveRequest`), which phoenix throws on (SSE is served by the DO). The publish path is 100% phoenix-driven.

## Decision

Delete `livePublishContext` (and the `node:async_hooks` import). The per-request publisher becomes an Effect `Context.Service`, `LiveBus`, acquired in mutation resolvers with `const {use, useIgnore} = yield* LiveBus`. The bus's fluent client (`PhoenixLiveEventBus`, sync) stays exactly as-is; only how it is obtained changes (`import` → `yield*`).

`LiveBus` exposes **two methods**, modeled on effect-smol's `NodeRedis.use` (adapted to a synchronous client):

- `use: <A>(f: (bus: PhoenixLiveEventBus) => A) => Effect<A, LivePublishError>` — runs `f(bus)` via `Effect.try`, **surfaces** a tagged `LivePublishError`.
- `useIgnore: (f: (bus: PhoenixLiveEventBus) => unknown) => Effect<void, never>` — `use(f).pipe(Effect.ignore({ log: "Warn" }))`. **Swallows** failures (logged, never propagated).

Mutations call `yield* (yield* LiveBus).useIgnore(bus => bus.connection(...).appendNode(...))`. `useIgnore` is mandatory for mutation publishes: a mutation must never fail because a publish failed.

Two layers:

- `LiveBusLive` — provided **per request** in the `/fate` route (it closes over `Cloudflare.WorkerExecutionContext.waitUntil` + `LiveTopics`), exactly where `Auth` is provided. Replaces the `livePublishContext.run` wrapper with `Effect.provideService(LiveBus, …)`.
- `LiveBusTest` — a capturing layer whose sink records the **resolved topic keys** (run through the real `topicsForPublish`, not a hand-faked bus). Bridge tests provide it and assert the captured keys.

The fat `liveBusConfig` object still passed to `createFateServer` is kept as-is (subscribe-only role for fate; its publish methods become vestigial). Splitting it to a bare subscribe stub is deferred as cosmetic.

`LiveBus` is added to `FateEnv`.

## Consequences

- **The void contract is a type, not a convention.** `useIgnore: Effect<void, never>` cannot fail; Effect short-circuits on yielded errors and the publish sits *after* the DB write, so a surfaced-and-yielded publish failure would otherwise turn a committed mutation into a client-visible error. The empty error channel makes that unrepresentable — no try/catch, no throwing-sink test.
- **The silent-no-op bug is structurally impossible.** Acquiring the bus with `yield* LiveBus` makes provision mandatory: a missing provide fails loudly instead of no-opping. Tests are forced to provide a (capturing) `LiveBus`, which is what lets them assert published topics — including a wrong-but-valid mis-route (the args-scoped key collapsing to the global wildcard).
- `node:async_hooks` and the ALS are gone; the route binds the publisher the same way it binds every other per-request service.
- **Banned:** reintroducing an AsyncLocalStorage (or any ambient `globalThis`/`Fiber.getCurrent` read) to carry the publisher. A sync client needed inside a resolver is acquired via `yield* Service` and wrapped with a `use`/`useIgnore` pair. `useUnsafe` is the wrong name for the swallow variant — in Effect `Unsafe` means "synchronous / escapes the runtime" (`PubSub.publishUnsafe`), not "swallows errors."
- Establishes the `use` / `useIgnore` wrapper convention for wrapping any non-Effect client in a `Context.Service`. To be documented in `.patterns/effect-context-service.md` as B3 lands (promote to a standalone pattern doc once a second client wrapper exists).
- Touch set: `fate-live/event-bus.ts`, `fate/route.ts`, `fate/server.ts`, `fate/layers.ts`, `sozluk/mutations.ts`, `pano/mutations.ts`, `fate/bridge-*.test.ts`.
