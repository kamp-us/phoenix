# fate-effect worker wiring — the server composition at the worker edge

How `apps/web/worker` serves `@kampus/fate-effect`: the one config, the composed layer, the
init-only runtime, and the per-request seam. Since the v2 cutover (ADR 0043) the `/fate` route
serves the NATIVE interpreter ([fate-effect-interpreter.md](./fate-effect-interpreter.md)) on
the request fiber — the compile path ([fate-effect-compiler.md](./fate-effect-compiler.md)) is
the differential oracle's baseline plus the build-time codegen surface, not a serving path.
Every record is a `Fate.*` entry composed from the per-feature aggregator barrels.

## The pieces (one config, two consumers)

```
worker/features/fate/
├── config.ts      # fateConfig = FateServer.config({queries, lists, mutations, sources, live})
├── sources.ts     # the features' Fate.source entries, composed into the config's array
├── layers.ts      # PhoenixFateLive = FateServer.layer(fateConfig) ⊕ makeFateLayer; makeFateRuntime
├── route.ts       # POST /fate: FateInterpreter.handleRequest on the request fiber + abort wiring
├── schema.ts      # fateServer = FateExecutor.toCodegenServer(fateConfig)  (Vite codegen, inert)
└── run-fate-op.ts # runFateOp — the in-process mirror of route.ts
```

- **`config.ts`** is the single declaration both edges consume. Record values are the features'
  `Fate.query`/`Fate.list`/`Fate.mutation`/`Fate.source` entries, spread from the per-feature
  barrels. It is **import-pure**: importing it captures handler functions and builds no runtime,
  which the codegen path depends on.
- **`sources.ts`** composes the per-feature `Fate.source` entries into the ARRAY form
  `FateServer.config` takes. Definition objects are the features' exported objects, never
  copies: fate's registry is identity-keyed.
- **Source completeness is validated**: every view-reachable entity must be registered, so an
  entity that is *reachable but deliberately unfetchable* (e.g. `Contribution`, whose rows are
  synthetic and whose connection is a custom resolver per ADR 0019) registers a
  **capability-less entry** (`Fate.syntheticSource(ViewClass)` — see
  [fate-effect-sources.md](./fate-effect-sources.md) "The escape hatch") — `getSource` resolves,
  any capability call fails loudly.

## The layer and the init-only runtime (ADR 0041/0043)

```ts
// layers.ts
export const PhoenixFateLive: Layer.Layer<WorkerFateServices | FateServer, never, Database | BetterAuth> =
	FateServer.layer(fateConfig).pipe(Layer.provideMerge(makeFateLayer));

// index.ts (worker init — once per isolate, never disposed: CF has no shutdown hook)
const {contextLayer: fateLayer} = makeFateRuntime(
	PhoenixFateLive.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
);
// NO init warmup — the layer builds lazily on the first request (see below).
```

- **The `ManagedRuntime` is init-only wiring** (ADR 0043): no request runs through it. It is
  the layer-build/memoization vehicle behind `contextLayer`
  (`Layer<WorkerFateServices | FateServer>`, `Layer.effectContext` over the runtime's built
  context), which `HttpRouter.provideRequest` discharges into the routes — the `/fate` route's
  interpreter program takes `FateServer` from there, and routes yield worker services
  (`Pasaport`) from the same one built context.
- **`makeFateRuntime` (`layers.ts`) is the single construction point.** It wraps
  `Layer.makeMemoMapUnsafe()` + `ManagedRuntime.make(layer, {memoMap})` +
  `Layer.effectContext(runtime.contextEffect)`. The shared `memoMap` (passed at
  `ManagedRuntime.make`) is what keeps layer memoization consistent between the runtime and the
  route-context layer derived from it: `contextEffect` resolves the runtime's already-built
  context, and wrapping it as a layer reuses those exact instances instead of rebuilding the
  layer per request — the routes see the **same** singletons the runtime carries, not a second
  copy. The layer graph itself (mergeAll / provide / provideMerge) is the one in
  [effect-layer-composition.md](./effect-layer-composition.md).
- **`provideMerge`, not `provide`**: the layer must carry the `WorkerFateServices` singletons
  *alongside* `FateServer` — both reach the routes through the one `contextLayer`.
- `FateServer.layer`'s own R (handler/source requirements minus the per-request pair) is
  discharged by the same domain layers — a record needing a forgotten service is a compile error
  at this composition site.
- **The layer builds lazily on the first request — there is deliberately NO init warmup.**
  Worker init constructs the `ManagedRuntime` value only; the first `/fate` request forces the
  layer build through `provideRequest`.
  - **Hazard: async work in the isolate's init (global) scope hangs deployed workerd.** Forcing
    the layer build in init (`yield*`-ing the runtime's `contextEffect` / awaiting
    `runtime.context()` inside `Phoenix.make`'s init phase) stalls the worker before it can
    serve a single request —
    observed as the `integration` harness's `/api/health` readiness poll never succeeding after a successful
    deploy. Build lazily; never block init on the runtime.
  - **Config validation does not wait for the first request.** The same `collectConfigIssues`
    walk `FateServer.layer` runs is executed at BUILD time by `FateExecutor.toCodegenServer`
    in `schema.ts` — a bad config (duplicate wire names, missing sources) throws
    `FateServerConfigError` during `vite build`, which every deploy runs.
  - **Accepted gap:** a config error that only manifests at layer-build time (i.e. not caught by
    `collectConfigIssues`) surfaces on the first `/fate` request instead of at init — the
    alternative (init warmup) is the hang above.

### CF deviation — never dispose

effect-smol's `LLMS.md` integration example disposes the runtime on `SIGINT`/`SIGTERM`. A
Cloudflare Worker isolate **has no shutdown hook**, so phoenix never calls `dispose()`: the
runtime lives for the isolate's lifetime, and Drizzle/D1 holds no poolable socket to release, so
there is nothing leaked by not disposing. Recorded in
[ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md). If a service genuinely
needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the
runtime. (The Node test harness `runFateOp`, below, HAS a shutdown point, so it builds and
disposes a runtime per operation.) This is strictly about runtime teardown — mutations still
fan out to the topic DO via `executionCtx.waitUntil(...)` so the live fan-out doesn't block the
response.

## The route (the per-request seam)

`handleFate` (a plain route handler Effect — `fateRoute = HttpRouter.add("POST", "/fate",
handleFate)`) builds **one context object** per request and yields the interpreter on the
request fiber:

```ts
const ctx: FateRequestContext = {
	currentUser: {user: session?.user},          // CurrentUserInfo is a structural subset — direct assignment
	livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
	// no `signal` field — abort is wired at this edge, below
};
const res = yield* FateInterpreter.handleRequest(raw, ctx).pipe(interruptOnAbort(raw.signal));
```

- **No runtime, no Promise hop**: `handleRequest` is `Effect<Response, never, FateServer>`;
  the platform layer (alchemy's worker bridge running the compiled router) owns the single run
  boundary for the whole HTTP surface. Handler/source `Effect.fn` spans therefore nest under
  the router's request span (the `HttpEffect.toHandled` tracer middleware) — pinned in the
  package's `Interpreter.batch.test.ts`.
- **Abort → interruption is the route's job**: alchemy's bridge wires no signal, so
  `interruptOnAbort(signal)` (`worker/http/interrupt-on-abort.ts`, beside the router assembly
  it serves; unit-tested in `interrupt-on-abort.unit.test.ts`)
  forks the program as a child of the request fiber and interrupts it from the signal's
  `abort` listener — effect-smol's own platform idiom (`HttpEffect.toWebHandlerWith`).
- **One ctx object per request**: the interpreter provides the pair as VALUES off this object
  to every operation. Never copy/rebuild it per resolver.
- The publish surface rides one topic capability: the worker-init `LiveTopics.publish` with the
  route's `LiveLimits` applied + the request's `waitUntil`. `livePublisherFor` (the per-request
  `LivePublisher` service value) builds frames + topic keys directly — the one
  frame-building code path; the static `liveBusConfig` fate holds is a throwing stub
  for the build-time `"subscribe" in live` check only.

## `schema.ts` (build time — the codegen export)

`schema.ts` exports `fateServer = FateExecutor.toCodegenServer(fateConfig)` + the views barrel.
The fate Vite plugin `runnerImport`s it with no database: same record keys, same `type` strings,
same `roots: {}`/`live` passthrough as the live config, every handler inert — so the manifest
(and the generated client) matches the served wire contract. Build-time config validation
throws the same `FateServerConfigError` the layer dies with. The worker entry never imports
`schema.ts`; the serving path is `route.ts` → `FateInterpreter.handleRequest`.

## `runFateOp` (the in-process route mirror)

The in-process mirror of the route, same composition over the caller's worker layer, serving through
the SAME interpreter the route serves:

```ts
const {runtime} = makeFateRuntime(FateServer.layer(fateConfig).pipe(Layer.provideMerge(workerLayer)));
const res = await runtime.runPromise(FateInterpreter.handleRequest(request, ctx));
// ctx: FateRequestContext with a recording livePublisherFor (capturing publish + collected
// waitUntil promises, flushed before returning) — `published` is the array of resolved topic
// keys the operation's live.* fanned out to. The per-op runtime is the Node harness's RUN
// vehicle (production's conversion point is the platform layer's).
// finally: await runtime.dispose()  — the Node harness HAS a shutdown point (per-op lifecycle)
```

Returns `{status, result, published}`. The signature is unchanged from the bridge-era harness,
so suites written against the bridge ran unchanged against the fate-effect server — that
unchanged-suite property WAS the migration's behavioral evidence, and the suites remain the
data-plane regression harness.

## What not to do

- **Don't compose `FateServer.layer` with plain `Layer.provide(makeFateLayer)`.** The built
  context would carry only `FateServer`; the route-context layer needs the worker singletons in
  the output too. `provideMerge` is load-bearing.
- **Don't run the interpreter through a runtime in the route.** It is an ordinary Effect on the
  request fiber; a runtime hop would detach spans from the request span and re-create the
  conversion point ADR 0043 removed.
- **Don't import `schema.ts` from worker runtime code.** It is the build-time artifact; the
  serving path is the interpreter over the route context. (Conversely the Vite plugin must
  never import `layers.ts`/`index.ts` — `config.ts` is the shared, import-pure meeting point.)
- **Don't register a real-looking executor for an unfetchable entity.** A capability-less entry
  keeps "no fetch path" an explicit, loud property; inventing a `byId` that queries something
  invents behavior that never existed.
- **Don't add an init warmup** (`yield* runtime.contextEffect` or awaiting `runtime.context()`
  in worker init): workerd disallows async/timer work in the isolate's init scope and the
  deployed worker hangs before serving. The layer builds lazily on first request; config
  validation already happens at `vite build` time via `toCodegenServer`'s `collectConfigIssues`.
- **Don't smuggle abort through the ctx.** The served `FateRequestContext` deliberately has no
  `signal` field — the interpreter would never read it, and a field nobody reads misleads
  route authors; the only signal-bearing context is the oracle baseline's
  Executor-local `ExecutorRequestContext` inside the package. The route's abort handling is
  `interruptOnAbort`.
