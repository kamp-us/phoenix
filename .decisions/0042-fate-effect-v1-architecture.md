---
id: 0042
title: fate-effect v1 — the Effect-native fate integration; the bridge is deleted
status: amended-in-part by [0043](0043-fate-effect-v2-native-interpreter-cutover.md)
date: 2026-06-10
tags: [fate, effect, architecture, errors, live, framework]
---

# 0042 — fate-effect v1: the Effect-native fate integration; the bridge is deleted

## Context

The fate↔Effect bridge (`worker/features/fate/effect.ts` + friends) was the seam where
protocol-neutral Effect domain services met fate's `(args) => Promise` resolver callbacks:
generator-wrapping helpers (`fateQuery`/`fateList`/`fateMutation`/`fateSource`), a per-request
`FateContext` smuggling `{runtime, request, auth, liveBus}` through fate's adapterContext, a
hand-maintained `_tag` → wire-code registry (`WIRE_CODE_BY_TAG` / `encodeFateError` — three
edits per new error), zod input schemas, and the per-call-site `liveBus.useIgnore` publish
convention (ADR 0039).

The fate-effect feature (PRD `projects/phoenix/features/fate-effect`) replaced that seam with a
workspace package, `@phoenix/fate-effect`: fate's structure with Effect's semantics. The
migration ran sozluk → pano → pasaport/stats as in-place rewrites under unchanged T2/T3 suites
and byte-identical codegen; after the last migration commit (`62a84a1`) nothing consumed the
bridge. This ADR records the v1 architecture and the cutover that deleted the bridge.

## Decision

### The package (`packages/fate-effect`) — five exports

- **`Fate`** — value constructors for fate's own record entries: `Fate.query`/`Fate.list`/
  `Fate.mutation` pair a pure-data definition (Effect Schema `args`/`input`, success view,
  declared `error` union) with an `Effect.fn("<wire name>")` handler whose error channel is
  compile-checked against the declared union; `Fate.source(ViewClass, {id}, handlers)` builds an
  entity loader with the loader contract (≥1 of `byId`/`byIds`, silent reads, `E = never`)
  enforced at the type level. Sources LOAD (absence = fewer rows), operations RESOLVE (typed
  errors) — the loader/resolver split.
- **`FateDataView`** — the view class factory: the class is the nameable export (TS2883), its
  static `view` IS the kernel `dataView()` value, and `Entity<typeof View, Replacements>`
  derives the entity type from the one declared field map.
- **`FateServer`** — the package-owned service tag; `FateServer.config` mirrors
  `createFateServer`'s options shape, `FateServer.layer(config)` is the one composite whose R is
  the union of handler/source requirements minus the per-request pair — a forgotten domain layer
  is a compile error at the composition site. Init-time validation (duplicate wire names, source
  completeness for view-reachable entities) fails with names attached.
- **`FateExecutor`** — the v1 compile step: `toFetchHandler(runtime)` resolves the `FateServer`
  service and compiles the config to a **real `createFateServer` value** (memoized), wrapping
  every handler as decode → provide the per-request pair → run on the worker runtime → encode;
  `toCodegenServer(config)` is the build-time inert twin `schema.ts` exports for Vite codegen
  (no database at build time; same config validation at `vite build`).
- **`CurrentUser` / `LivePublisher`** — the per-request contract. No worker layer provides them;
  the compile step provides the VALUES from the route-built `FateRequestContext`
  (`{currentUser, livePublisher, signal}`). `CurrentUser.required` gates writes with the
  annotated `Unauthorized`; every `LivePublisher` method is `Effect<void>` (`E = never`) — the
  waitUntil scheduling and swallow-with-log live inside the worker's `livePublisherFor` layer
  ONCE, so "a publish cannot fail the mutation" is a type, not the bridge's per-call-site
  `useIgnore` convention.

### The one-runtime boundary (ADR 0041 retained)

The worker still builds exactly ONE isolate-level `ManagedRuntime` (never disposed on CF — no
shutdown hook), now from `PhoenixFateLive = FateServer.layer(fateConfig) ⊕
provideMerge(makeFateLayer)`, via the single construction point `makeFateRuntime`. The single
Effect→Promise conversion moved from the bridge's `runEffect` into the package's `Executor.ts`
(`runtime.runPromiseExit(handler.pipe(provideService pair), {signal})`) — span nesting (F4) and
the LLMS.md ManagedRuntime integration idiom are unchanged. 0041's bridge *mechanism*
(`ctx.runtime`, `FateContext`, the F7 `genEffect` cast) is gone; its runtime doctrine survives.

### Wire errors — annotation, not registry

A domain error class carries its wire code as a schema annotation
(`{[fateWireCode]: "CODE"}` on `Schema.TaggedErrorClass`); `encodeWireError` derives the wire
shape from the class. One class, one code (families split per sub-code with union aliases).
Un-annotated errors and defects encode as `INTERNAL_SERVER_ERROR` with a fixed message (infra
failures are defects — handlers pipe `orDieDrizzle`); Schema rejections encode as
`VALIDATION_ERROR` pre-handler. Guards: per-feature `errors.unit.test.ts` enumeration pins, plus
`wireCodes.unit.test.ts` re-derived for the cutover — it walks the fate config's declared error
unions (annotations off the union members' ASTs) + the package fallbacks and asserts the SPA's
`MUTATION_ERROR_CODES` covers the set, replacing the registry-derived `WIRE_CODES` guard.

### The cutover (this commit) — what was deleted, what replaced it

| Deleted | Replaced by |
|---|---|
| `fate/effect.ts` (`fateQuery`/`fateList`/`fateMutation`/`fateSource`, the runner, the F7 cast) | `Fate.*` constructors + `FateExecutor`'s compile pipeline |
| `fate/context.ts` (`FateContext`, `CoexistenceFateContext`) | the package's `FateRequestContext` (`currentUser`, `livePublisher`, `signal`) |
| `fate/errors.ts` (`WIRE_CODE_BY_TAG`, `FateErrorTag`, `encodeFateError`, `WIRE_CODES`) | `fateWireCode` annotations + `encodeWireError`; config-derived guard in `wireCodes.unit.test.ts` |
| `pasaport/Auth.ts` (`Auth` service, worker `Unauthorized`) | `CurrentUser` / package `Unauthorized` |
| `event-bus.ts` typed bridge surface (`LiveBus` service, `useIgnore`, `liveBusFor`, `makeLiveBus`, `liveBus`, `PhoenixLiveEventBus`, `TypedLiveUpdate`/`TypedLiveConnection`) | `LivePublisher` over `makeLiveEventBus` (which survives as the ONE frame-building path, with `LivePublishError` + `liveBusConfig`) |
| `view-types.ts` `EntityOf`/`DataViewOf`; `views.ts` `LiveEntities`/`LiveChangedField` | `FateDataView` classes + `Entity<typeof View>`; (`ViewRow` survives) |
| route/`run-fate-op.ts` coexistence fields | bare `FateRequestContext` (signatures unchanged — the T2 suites ran unedited through the whole migration and remain the regression harness) |
| `.patterns/fate-effect-bridge.md`, `.patterns/fate-server-wiring.md` | `fate-effect-server/compiler/worker-wiring` docs |

zod is GONE from all fate input paths (Effect Schema is the one codec layer). The `zod`
dependency itself **stays** in `apps/web/package.json`: better-auth's type augmentation
(`pasaport/better-auth-live.ts`, `src/auth/client.ts` — `import type {} from "zod/v4/core"`,
predating this feature) needs the package for types.

## Accepted v1 behavioral deltas

Recorded across the migration tasks; all unexercised by suites and invisible to the generated
client:

- Required Schema args reject args-less ops as `VALIDATION_ERROR` pre-handler where bridge
  resolvers resolved `get*("")` → null (`term`, `post`, `profile`); wrong-TYPE args reject as
  `VALIDATION_ERROR` where defensive `typeof` checks silently ignored them.
- Input decode precedes `CurrentUser.required` (the bridge checked auth first) — observable only
  for malformed-input + anonymous combined.
- Anonymous gated writes carry the message "Authentication required" (package
  `Unauthorized`) where the sozluk/pano registry rows said "not authorized"; codes unchanged
  (`UNAUTHORIZED`).
- A real DB failure's wire message is the fixed internal message instead of `e.message ?? …`
  (defect path; same `INTERNAL_SERVER_ERROR`).
- The bridge's compile-time typed live surface (`TypedLiveUpdate` entity/field narrowing,
  `TypedLiveConnection` procedure narrowing) is gone: the package `LivePublisher` is
  string-typed (it cannot know phoenix's entities/procedures). The subscribe side stays
  schema-closed (`LiveConnectionProcedureSchema`); publish-site typos are caught by the live T3
  suite. Re-introducing a worker-level narrowing wrapper is possible if typos recur.
- `VALIDATION_ERROR` added to the SPA's `MUTATION_ERROR_CODES` — the cutover's config-derived
  guard surfaced that the server emits it (fate schema validation always did; the package's
  `InputValidationError` does so uniformly) while the SPA list omitted it (decoding it to the
  `INTERNAL_SERVER_ERROR` fallback). All SPA `switch`es have defaults; behavior is unchanged
  until a call site opts into the distinct code.

## Reconciliation

- **[0016](0016-fate-pure-transport-effect-services-domain.md)** — reinforced: fate is still
  pure transport; the services are still the domain; `createDrizzleSourceAdapter` still banned.
- **[0017](0017-hono-route-owns-fate-runtime.md)** — stays superseded (by 0029); no per-request
  runtime returned.
- **[0029](0029-worker-runtime-servicemap.md)** — stays superseded-in-part by 0041; its
  worker-level-singletons insight survives in `makeFateLayer`.
- **[0039](0039-livebus-context-service.md)** — **amended-in-part by this ADR**: the `LiveBus`
  `Context.Service` and the `use`/`useIgnore` call-site pattern are deleted. The decision's core
  — the publish capability is acquired in Effect-world per request (no `AsyncLocalStorage`), and
  a publish failure must not fail the committed mutation — survives, strengthened: the swallow
  law now lives inside `livePublisherFor` once, and the no-fail contract is `LivePublisher`'s
  type (`Effect<void, never>`), not a convention.
- **[0041](0041-fate-bridge-worker-managed-runtime.md)** — **amended-in-part by this ADR**: the
  one worker-level `ManagedRuntime` (built once, never disposed on CF, shared `memoMap`,
  span-nesting F4 fix) is retained verbatim; the bridge mechanism it ran (`FateContext`,
  `ctx.runtime.runPromiseExit`, the F7 `genEffect` cast) is deleted — the run boundary is now
  `packages/fate-effect/src/Executor.ts`. 0041's Gate-B note ("the bridge stays app-local") is
  resolved differently than predicted: the seam graduated into `@phoenix/fate-effect` as a
  designed package (the PRD's grilled design), not by extracting the bridge.
- **[0013](0013-validation-in-service-methods.md) / [0019](0019-connection-pagination-strategy.md)
  / [0020](0020-fate-mutation-conventions.md)** — unchanged: domain validation stays in
  services (the definition Schema is shape-coercion only), keyset pagination stays
  resolver-owned, mutation conventions carry over.

## What v2 changes (not this ADR)

`FateExecutor.route()` — the native Effect interpreter (kernel-only imports, `RequestResolver`
batching, one Effect→Promise crossing per request), developed against the v1 compiled server as
a differential oracle. The package's `RawFateOperation`/`RawFateSourceEntry` config arms (the
migration-coexistence affordance, unused since this cutover) are slated for removal there.

Builds on [0040](0040-testing-taxonomy-and-seam-graduation.md) (the suites that made the
migration's wire-parity claim checkable) and [0041](0041-fate-bridge-worker-managed-runtime.md).
