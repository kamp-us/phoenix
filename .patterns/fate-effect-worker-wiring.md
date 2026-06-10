# fate-effect worker wiring — the v1 server composition at the worker edge

How `apps/web/worker` runs `@phoenix/fate-effect`'s v1 server: the one config, the composed
layer, the one runtime, and the per-request adapters — the worker-side half of
[fate-effect-compiler.md](./fate-effect-compiler.md) (the package-side mechanism). This is the
zero-migration cutover shape (task 9): every record is still a raw legacy bridge entry, behavior
is wire-identical, and migrations (sozluk → pano → pasaport) only swap record values inside the
same composition.

## The pieces (one config, two consumers)

```
worker/features/fate/
├── config.ts      # fateConfig = FateServer.config({queries, lists, mutations, sources, live})
├── sources.ts     # the legacy {definition, executor} pairs, annotated RawFateSourceEntry
├── layers.ts      # PhoenixFateLive = FateServer.layer(fateConfig) ⊕ makeFateLayer; makeFateRuntime
├── route.ts       # POST /fate: toFetchHandler(runtime) + the per-request context build
├── schema.ts      # fateServer = FateExecutor.toCodegenServer(fateConfig)  (Vite codegen, inert)
├── context.ts     # FateContext (legacy) + CoexistenceFateContext (the one ctx object)
└── run-fate-op.ts # runFateOp v2 — the T2 harness mirror of route.ts
```

- **`config.ts`** is the single declaration both edges consume. Record values are raw legacy
  bridge entries (or, post-migration, `Fate.*` entries) — coexistence is literally the spreads.
  It is **import-pure**: importing it captures resolver functions and builds no runtime, which
  the codegen path depends on.
- **`sources.ts`** composes the per-feature `{definition, executor}` pairs into the ARRAY form
  `FateServer.config` takes, every entry annotated `RawFateSourceEntry` **at the declaration
  site** (a kernel `dataView()` inside an exported config would otherwise surface fate's
  non-exported symbol key — TS2883). Definition objects are the features' exported objects, never
  copies: fate's registry is identity-keyed.
- **Source completeness is now validated**: every view-reachable entity must be registered, so an
  entity that is *reachable but deliberately unfetchable* (e.g. `Contribution`, whose rows are
  synthetic and whose connection is a custom resolver per ADR 0019) registers a
  **capability-less executor** (`{}`) — `getSource` resolves, any capability call fails loudly,
  exactly as the unregistered entity did before.

## The layer and the one runtime (ADR 0041)

```ts
// layers.ts
export const PhoenixFateLive: Layer.Layer<WorkerFateServices | FateServer, never, Database | BetterAuth> =
	FateServer.layer(fateConfig).pipe(Layer.provideMerge(makeFateLayer));

// index.ts (worker init — once per isolate, never disposed: CF has no shutdown hook)
const {runtime: fateRuntime, contextLayer: fateLayer} = makeFateRuntime(
	PhoenixFateLive.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
);
// NO init warmup — the layer builds lazily on the first request (see below).
```

- **`provideMerge`, not `provide`**: the runtime must carry the `WorkerFateServices` singletons
  *alongside* `FateServer` — the routes yield worker services from the runtime-derived
  `contextLayer`, and legacy bridge records run through `ctx.runtime` during coexistence.
  `ManagedRuntime` is contravariant in R, so the wider `WorkerRuntime` satisfies both the
  package's `FateExecutorRuntime` (`ManagedRuntime<FateServer>`) and the legacy
  `FateContext.runtime` (`ManagedRuntime<WorkerFateServices>`).
- `FateServer.layer`'s own R (handler/source requirements minus the per-request pair) is
  discharged by the same domain layers — a migrated record needing a forgotten service is a
  compile error at this composition site. At zero migration that R is `never`.
- **The layer builds lazily on the first request — there is deliberately NO init warmup.**
  Worker init constructs the `ManagedRuntime` value only; the first `/fate` request forces the
  layer build (and `toFetchHandler` compiles lazily on first call and memoizes). This is exactly
  the bridge's behavior.
  - **Hazard: async work in the isolate's init (global) scope hangs deployed workerd.** Forcing
    the layer build in init (`yield* fateRuntime.contextEffect` / awaiting `runtime.context()`
    inside `Phoenix.make`'s init phase) stalls the worker before it can serve a single request —
    observed as the T3 harness's `/api/health` readiness poll never succeeding after a successful
    deploy. Build lazily; never block init on the runtime.
  - **Config validation does not wait for the first request.** The same `collectConfigIssues`
    walk `FateServer.layer` runs is executed at BUILD time by `FateExecutor.toCodegenServer`
    in `schema.ts` — a bad config (duplicate wire names, missing sources) throws
    `FateServerConfigError` during `vite build`, which every deploy runs.
  - **Accepted gap:** a config error that only manifests at layer-build time (i.e. not caught by
    `collectConfigIssues`) surfaces on the first `/fate` request instead of at init. That is the
    bridge's exact failure timing, so the cutover loses nothing — and the alternative (init
    warmup) is the hang above.

## The route (the per-request seam)

`makeHandleFate(runtime)` binds `FateExecutor.toFetchHandler(runtime)` once; per request it
builds **one context object** and serves through the compiled server:

```ts
const ctx: CoexistenceFateContext = {
	// the fate-effect per-request contract (FateRequestContext)
	currentUser: {user: session?.user},          // CurrentUserInfo is a structural subset — direct assignment
	livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
	signal: raw.signal,                          // client abort interrupts the resolver fiber
	// the legacy bridge FateContext, on the SAME object (coexistence)
	runtime, request: raw,
	auth: {user: session?.user, session: session?.session},
	liveBus: liveBusFor(publisher),
};
const res = yield* Effect.promise(() => handleFate(raw, ctx));
```

- **Identity is the compat contract**: the compiled `context` factory returns the object it was
  handed (pinned in the package's `Executor.test.ts`), so compiled entries read the pair and
  legacy records read their `FateContext` fields off the same object. Never copy/rebuild the
  ctx per resolver.
- Both publish surfaces share one topic capability: the worker-init `LiveTopics.publish` with the
  route's `LiveLimits` applied + the request's `waitUntil`. `livePublisherFor` (the fate-effect
  service value) and `liveBusFor` (the bridge bus, dies with the bridge) resolve frames through
  the same `makeLiveEventBus`, so the wire shape cannot fork.

## `schema.ts` (build time — the codegen export)

`schema.ts` exports `fateServer = FateExecutor.toCodegenServer(fateConfig)` + the views barrel.
The fate Vite plugin `runnerImport`s it with no database: same record keys, same `type` strings,
same `roots: {}`/`live` passthrough as the live compile, every handler inert — so the manifest
(and the generated client, byte-for-byte at the zero-migration cutover) matches the served
server. Build-time config validation throws the same `FateServerConfigError` the layer dies
with. The worker entry never imports `schema.ts`; the live path is `route.ts` → `toFetchHandler`.

## `runFateOp` v2 (the T2 harness)

The test mirror of the route, same composition over the caller's worker layer:

```ts
const {runtime} = makeFateRuntime(FateServer.layer(fateConfig).pipe(Layer.provideMerge(workerLayer)));
const handleFate = FateExecutor.toFetchHandler(runtime);
// ctx: CoexistenceFateContext with a recording livePublisherFor (capturing publish + collected
// waitUntil promises, flushed before returning) AND a capturing liveBusFor — one `published`
// array of resolved topic keys, whichever surface the record publishes through.
// finally: await runtime.dispose()  — the Node harness HAS a shutdown point (per-op lifecycle)
```

Returns `{status, result, published}`. The signature is unchanged from v1, so suites written
against the bridge run unchanged against the fate-effect server — that unchanged-suite property
IS the cutover's behavioral evidence.

## What not to do

- **Don't compose `FateServer.layer` with plain `Layer.provide(makeFateLayer)`.** The runtime
  would carry only `FateServer`; the route-context layer and (during coexistence) `ctx.runtime`
  need the worker singletons in the runtime's output. `provideMerge` is load-bearing.
- **Don't import `schema.ts` from worker runtime code.** It is the build-time artifact; the
  served server comes from `toFetchHandler` over the runtime. (Conversely the Vite plugin must
  never import `layers.ts`/`index.ts` — `config.ts` is the shared, import-pure meeting point.)
- **Don't register a real-looking executor for an unfetchable entity.** A capability-less `{}`
  keeps "no fetch path" an explicit, loud property; inventing a `byId` that queries something
  invents behavior the bridge never had.
- **Don't build a second context object for legacy records** (or "adapt" them) — identity, not
  adaptation, is what keeps the bridge records' runtime/zod/`defaultSize` behavior untouched.
- **Don't add an init warmup** (`yield* runtime.contextEffect` or awaiting `runtime.context()`
  in worker init): workerd disallows async/timer work in the isolate's init scope and the
  deployed worker hangs before serving. The layer builds lazily on first request; config
  validation already happens at `vite build` time via `toCodegenServer`'s `collectConfigIssues`.
