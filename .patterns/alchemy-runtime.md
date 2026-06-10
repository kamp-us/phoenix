# The runtime

How domain services get from the worker into a fate handler. The short answer: there is **no _per-request_ `ManagedRuntime`** — there is exactly ONE _worker-level_ `ManagedRuntime`, built once per isolate in the worker init and never disposed (the CF deviation, below). The worker provides `Drizzle` and the feature services as worker-level layers folded into that runtime — together with the composed `FateServer` service (`PhoenixFateLive`); per request the route builds only the two genuinely per-request VALUES — `currentUser` and `livePublisher` — and hands the compiled fate server a `FateRequestContext` of `{currentUser, livePublisher, signal}`. The compile step (`FateExecutor`, [fate-effect-compiler.md](./fate-effect-compiler.md)) runs each handler through the runtime, providing the pair onto the effect. Nothing is built or disposed per request.

This is the doc to read before touching the seam between fate and the domain. It is the biggest departure from the old per-request-runtime design — and from the over-corrected zero-runtime design that briefly preceded it (ADR 0041, supersedes 0029).

## One worker-level runtime — not zero, not per-request

phoenix has had three runtime shapes; ADR 0041 records why the third is the right one:

- **The old per-request runtime** (`worker/features/fate/runtime.ts`) built a fresh `ManagedRuntime` on every `/fate` request and disposed it in `finally`. That was necessary because every binding came from a per-request `env`, so *everything* was request-scoped.
- **The zero-runtime correction** (ADR 0029) removed it: `Cloudflare.D1Connection.bind(PhoenixDb)` resolves **once per isolate**, so `Drizzle` and the features are isolate-stable and were provided as worker-level layers, then captured into a `Context` and run on the *default* runtime via `Effect.runPromiseExit(Effect.provide(effect, ctx.context))`. But that over-corrected: running on the default runtime put each resolver's spans on a **detached root** instead of nesting them under the request (F4).
- **The current shape** (ADR 0041): build ONE `ManagedRuntime` per isolate from the worker layers, and run every handler THROUGH it. The runtime is the seam that both holds the worker singletons AND nests handler spans under the request span — F4 — while still building nothing per request.

So the things built once per isolate are folded into the runtime:

- **Worker-level (folded into the one runtime):** `Drizzle`, every feature service that depends only on it — `Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats` (the `WorkerFateServices`) — and the composed `FateServer` service itself (`PhoenixFateLive = FateServer.layer(fateConfig) ⊕ provideMerge(makeFateLayer)`).
- **Request-level (provided onto each handler effect):** `CurrentUser` (the validated session) and `LivePublisher` (the publish capability — the package's documented per-request contract, [fate-effect-server.md](./fate-effect-server.md)). These genuinely vary per call, and ride the `FateRequestContext` as VALUES — not folded into the runtime.

## Building the one runtime in init

The worker init builds the runtime from `PhoenixFateLive` (its `R` is `Database | BetterAuth`, both resolved once in init and provided here) through `makeFateRuntime` — the single construction point, which also passes a shared `memoMap` so layer memoization stays correct across the runtime and the route-context layer derived from it:

```ts
// worker/index.ts
Effect.gen(function* () {
  const raw = yield* Database;
  const databaseLayer = Layer.succeed(Database)(raw);
  const betterAuth = yield* BetterAuth.BetterAuth;
  const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)(betterAuth);

  // ── THE ONE WORKER-LEVEL RUNTIME (ADR 0041) ──
  const {runtime: fateRuntime, contextLayer: fateLayer} = makeFateRuntime(
    PhoenixFateLive.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
  );

  const AppLive = makeAppLive({fateLayer, fateRuntime, /* … */});
  return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
});
```

`makeFateRuntime` (`features/fate/layers.ts`) wraps `Layer.makeMemoMapUnsafe()` + `ManagedRuntime.make(layer, {memoMap})` + `Layer.effectContext(runtime.contextEffect)`; the layer graph itself (mergeAll / provide / provideMerge) is exactly the one in [effect-layer-composition.md](./effect-layer-composition.md) — only *where* it's provided moved, into the one runtime built here.

### The runtime is the documented integration seam

This is not a phoenix invention. effect-smol's `LLMS.md` ("Integrating Effect into existing applications" section, with the `ai-docs/src/03_integration/10_managed-runtime.ts` example) describes exactly this shape: build one `ManagedRuntime` from your application's layers, then call `runtime.runPromise*` from each non-Effect callback. fate's `(args) => Promise` resolvers ARE that non-Effect callback boundary, so the runtime here is a faithful application of the documented idiom — the run boundary lives in `@phoenix/fate-effect`'s compile step ([fate-effect-compiler.md](./fate-effect-compiler.md)).

### CF deviation — never dispose

The `LLMS.md` example disposes the runtime on `SIGINT`/`SIGTERM`. A Cloudflare Worker isolate **has no shutdown hook**, so phoenix never calls `fateRuntime.dispose()`: the runtime lives for the isolate's lifetime, and Drizzle/D1 holds no poolable socket to release, so there is nothing leaked by not disposing. This is the one deliberate departure from the documented pattern, grounded in the platform — recorded in [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md). (The Node test harness `runFateOp` HAS a shutdown point, so it builds a runtime per operation and disposes it.)

## Sharing the built context with the routes — `Layer.effectContext`

Some routes (`Pasaport` in the `/fate` handler) `yield*` a worker service directly, outside the fate server. They must see the **same** singletons the runtime carries — not a second copy. `Layer.effectContext(fateRuntime.contextEffect)` (built inside `makeFateRuntime`) derives a route layer from the runtime's already-built `Context<WorkerFateServices>`:

```ts
// features/fate/layers.ts (inside makeFateRuntime)
const contextLayer = Layer.effectContext(runtime.contextEffect);
```

`contextEffect` resolves the runtime's built context; wrapping it as a layer reuses those exact instances instead of rebuilding the layer per request. So `Drizzle` and the feature services are built a single time and SHARED by both the fate runtime and the routes — one `memoMap` (passed at `ManagedRuntime.make`) keeps that sharing consistent.

## Request-level values, built in the route

`CurrentUser` and `LivePublisher` are the only per-request services. The `/fate` handler validates the session through the worker-level `Pasaport` (already in scope, no throwaway runtime), builds the two VALUES, and hands the compiled fate server a `FateRequestContext`:

```ts
// worker/features/fate/route.ts (mounted by the router — alchemy-http-router.md)
export const makeHandleFate = (runtime: WorkerRuntime) => {
  const handleFate = FateExecutor.toFetchHandler(runtime); // compiled ONCE, memoized
  return Effect.gen(function* () {
    const raw = yield* Cloudflare.Request;
    const pasaport = yield* Pasaport;                 // worker-level service
    const session = yield* pasaport.validateSession(raw.headers);

    const ctx: FateRequestContext = {
      currentUser: {user: session?.user},
      livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
      signal: raw.signal,                              // client abort interrupts the fiber
    };

    const res = yield* Effect.promise(() => handleFate(raw, ctx));
    return HttpServerResponse.fromWeb(res);
  });
};
```

The runtime is a **constructor argument** (`makeHandleFate(runtime)`), so the route holds no module-level runtime — `index.ts` is the single construction + ownership point. There is **no context capture and no per-request layer build**: the worker singletons live in the runtime, and `currentUser`/`livePublisher` ride the `FateRequestContext` as values.

## The compile step runs each handler through the runtime

The run boundary lives in `@phoenix/fate-effect`'s `Executor` ([fate-effect-compiler.md](./fate-effect-compiler.md)): `FateExecutor.toFetchHandler(runtime)` resolves the `FateServer` service from the runtime, compiles the real `createFateServer` value once, and wraps every handler as decode → provide the per-request pair → run on the runtime → encode:

```ts
// the shape inside packages/fate-effect/src/Executor.ts (simplified)
runtime.runPromiseExit(
  handler(input).pipe(
    Effect.provideService(CurrentUser, ctx.currentUser),
    Effect.provideService(LivePublisher, ctx.livePublisher),
  ),
  {signal: ctx.signal}, // abort signal interrupts the handler fiber
).then(/* Exit → value | throw encodeWireError(...) */);
```

This is the **single** Effect→Promise conversion point: `runtime.runPromiseExit(...)` is the only place a runtime is run, so handler spans nest under the runtime's request span (F4) and the pair is provided per handler while the worker singletons come from the runtime.

> **The runtime carries the worker FiberRefs too.** Because handlers run THROUGH the worker runtime (not a fresh default-runtime root), the runtime's logger, tracer, current span, and log level/annotations ARE in scope — that is precisely how handler spans nest under the request span (F4). This is the win the old `Effect.runPromiseExit(Effect.provide(...))` default-runtime path gave up. phoenix has ~59 `Effect.fn(...)`-traced functions; once a Tracer/exporter is installed at worker scope, those spans will be live children of the request with no further change. Today no exporter is installed, so the spans are inert — but the nesting structure is already correct.

> **No `dispose`, no `try/finally`, no `waitUntil` for runtime teardown.** The runtime is built once and never disposed (CF has no shutdown hook); the worker-level layers are released when the isolate is torn down, not per request. If a service genuinely needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the runtime. This is strictly about **runtime teardown** — it is not "no `waitUntil` anywhere." Mutations still fan out to the topic DO via `executionCtx.waitUntil(...)` so the work doesn't block the response; on alchemy that handle comes from `yield* Cloudflare.WorkerExecutionContext` (a service whose value is the CF `ExecutionContext`). The live fan-out `waitUntil` is a separate, still-required concern.

## One runtime, one layer set

phoenix's old design ran a per-request `ManagedRuntime`; the brief correction ran none. Now there is a single isolate-level runtime over one `Drizzle`:

- **worker-level (in the runtime)** — `Drizzle` + the feature services (`WorkerFateServices`) + the composed `FateServer`, built once per isolate, never disposed.
- **request-level (on the `FateRequestContext`)** — `currentUser` + `livePublisher`, provided onto each handler effect by the compile step.

`Drizzle` and the feature services are built once at worker init and folded into the runtime; the `/fate` route builds `currentUser`/`livePublisher` per request and the compile step provides them onto each handler effect with `Effect.provideService`. See [alchemy-http-router.md](./alchemy-http-router.md) for where each is provided.

## See also

- [fate-effect-compiler.md](./fate-effect-compiler.md) — the compile step this doc's run boundary lives in
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — the worker-side composition (`config.ts`/`layers.ts`/`route.ts`)
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, folded into the one runtime
- [alchemy-worker.md](./alchemy-worker.md) — where the runtime is built in worker init
- [alchemy-http-router.md](./alchemy-http-router.md) — where the per-request pair is built
- [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) — the worker-level `ManagedRuntime` decision (supersedes 0029)
