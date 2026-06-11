# The runtime

How domain services get from the worker into a fate handler. The short answer: there is **no _per-request_ `ManagedRuntime`** — and since the v2 cutover (ADR 0043) **no runtime on the request path at all**. The worker init builds exactly ONE _worker-level_ `ManagedRuntime` (never disposed — the CF deviation, below) as the **layer-build vehicle**: `Drizzle`, the feature services, and the composed `FateServer` service (`PhoenixFateLive`) are folded into it, and its built context reaches the routes as a dependency-free context layer. Per request the `/fate` route builds only the two genuinely per-request VALUES — `currentUser` and `livePublisher` — and yields the native interpreter (`FateInterpreter.handleRequest`, [fate-effect-interpreter.md](./fate-effect-interpreter.md)) on the request fiber. Nothing is built, run-through, or disposed per request.

This is the doc to read before touching the seam between fate and the domain.

## One worker-level runtime — not zero, not per-request, not serving

phoenix has had four runtime shapes; ADR 0041 + 0043 record the path:

- **The old per-request runtime** (`worker/features/fate/runtime.ts`) built a fresh `ManagedRuntime` on every `/fate` request and disposed it in `finally`. That was necessary because every binding came from a per-request `env`, so *everything* was request-scoped.
- **The zero-runtime correction** (ADR 0029) removed it: bindings resolve **once per isolate**, so `Drizzle` and the features became worker-level layers captured into a `Context` and run on the *default* runtime. But that over-corrected: resolver spans landed on detached roots (F4).
- **The v1 serving runtime** (ADR 0041): one `ManagedRuntime` per isolate, every compiled fate resolver run THROUGH it via `runtime.runPromise` — the documented `LLMS.md` integration idiom for fate's `(args) => Promise` callback boundary.
- **The current shape** (ADR 0043): the `(args) => Promise` boundary is gone from serving — the interpreter is an Effect, the route yields it, and the platform layer (alchemy's worker bridge running the compiled `HttpRouter.toHttpEffect`) owns the single run boundary for the whole HTTP surface. The runtime survives as **init-only wiring**: the memoized layer-build vehicle behind the route context layer.

So the things built once per isolate are folded into the runtime:

- **Worker-level (folded into the one runtime):** `Drizzle`, every feature service that depends only on it — `Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats` (the `WorkerFateServices`) — and the composed `FateServer` service itself (`PhoenixFateLive = FateServer.layer(fateConfig) ⊕ provideMerge(makeFateLayer)`).
- **Request-level (provided onto each operation effect by the interpreter):** `CurrentUser` (the validated session) and `LivePublisher` (the publish capability — the package's documented per-request contract, [fate-effect-server.md](./fate-effect-server.md)). These genuinely vary per call, and ride the `FateRequestContext` as VALUES — not folded into the runtime.

## Building the one runtime in init

The worker init builds the runtime from `PhoenixFateLive` (its `R` is `Database | BetterAuth`, both resolved once in init and provided here) through `makeFateRuntime` — the single construction point, which also passes a shared `memoMap` so layer memoization stays correct across the runtime and the route-context layer derived from it:

```ts
// worker/index.ts
Effect.gen(function* () {
  const raw = yield* Database;
  const databaseLayer = Layer.succeed(Database)(raw);
  const betterAuth = yield* BetterAuth.BetterAuth;
  const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)(betterAuth);

  // ── THE ONE WORKER-LEVEL RUNTIME (ADR 0041/0043 — init-only wiring) ──
  const {contextLayer: fateLayer} = makeFateRuntime(
    PhoenixFateLive.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
  );

  const AppLive = makeAppLive({fateLayer, /* … */});
  return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
});
```

`makeFateRuntime` (`features/fate/layers.ts`) wraps `Layer.makeMemoMapUnsafe()` + `ManagedRuntime.make(layer, {memoMap})` + `Layer.effectContext(runtime.contextEffect)`; the layer graph itself (mergeAll / provide / provideMerge) is exactly the one in [effect-layer-composition.md](./effect-layer-composition.md). There is deliberately **no init warmup** (async work in the isolate's init scope hangs deployed workerd — [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)): the layer builds lazily on the first request.

### CF deviation — never dispose

effect-smol's `LLMS.md` integration example disposes the runtime on `SIGINT`/`SIGTERM`. A Cloudflare Worker isolate **has no shutdown hook**, so phoenix never calls `dispose()`: the runtime lives for the isolate's lifetime, and Drizzle/D1 holds no poolable socket to release, so there is nothing leaked by not disposing. Recorded in [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md). (The Node test harness `runFateOp` HAS a shutdown point, so it builds a runtime per operation — its run vehicle for the interpreter program — and disposes it.)

## Sharing the built context with the routes — `Layer.effectContext`

The routes see the **same** singletons the runtime carries — not a second copy. `Layer.effectContext(runtime.contextEffect)` (built inside `makeFateRuntime`) derives the route layer from the runtime's already-built `Context<WorkerFateServices | FateServer>`:

```ts
// features/fate/layers.ts (inside makeFateRuntime)
const contextLayer = Layer.effectContext(runtime.contextEffect);
```

`contextEffect` resolves the runtime's built context; wrapping it as a layer reuses those exact instances instead of rebuilding the layer per request. `HttpRouter.provideRequest` discharges it into the routes (`http/app.ts`): the `/fate` route takes BOTH its directly-yielded worker services (`Pasaport`) and the interpreter's `FateServer` requirement from this one layer — one `memoMap` (passed at `ManagedRuntime.make`) keeps the sharing consistent.

## The request path: values in, Effect through, no runtime

The `/fate` handler validates the session through the worker-level `Pasaport` (already in scope, no throwaway runtime), builds the two VALUES, and yields the interpreter — wiring the request's abort signal to fiber interruption at this edge:

```ts
// worker/features/fate/route.ts (mounted by the router — alchemy-http-router.md)
export const handleFate = Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;
  const pasaport = yield* Pasaport;                 // worker-level service (contextLayer)
  const session = yield* pasaport.validateSession(raw.headers);

  const ctx: FateRequestContext = {
    currentUser: {user: session?.user},
    livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
    // no `signal` — abort is wired below, not smuggled through the ctx
  };

  const res = yield* FateInterpreter.handleRequest(raw, ctx).pipe(interruptOnAbort(raw.signal));
  return HttpServerResponse.fromWeb(res);
});
```

- **Abort → interruption**: alchemy's worker bridge runs the request fiber with `Effect.runPromiseExit` and no signal wiring, so `interruptOnAbort` (`worker/http/interrupt-on-abort.ts`, T0-tested) forks the program as a child of the request fiber and interrupts it from the signal's `abort` listener — the same mechanism effect-smol's own platform handler uses (`HttpEffect.toWebHandlerWith`).
- **There is no context capture and no per-request layer build**: the worker singletons come through `provideRequest`'s context layer, and `currentUser`/`livePublisher` ride the `FateRequestContext` as values, provided onto each operation effect by the interpreter (`Effect.provideService` — the v1 compiler's provision order, kept verbatim).

> **Spans nest under the request span for free.** The interpreter runs in the request fiber's tree, and the router's tracer middleware (`HttpEffect.toHandled`) opens the request span on that fiber — so every `Effect.fn` handler/source span (including loads through the walk's `RequestResolver` batch fiber) is a live child of the request. Pinned in the package's `Interpreter.batch.test.ts`. phoenix has ~59 `Effect.fn(...)`-traced functions; once a Tracer/exporter is installed at worker scope, those spans are live children of the request with no further change.

> **No `dispose`, no `try/finally`, no `waitUntil` for runtime teardown.** The runtime is built once and never disposed (CF has no shutdown hook); the worker-level layers are released when the isolate is torn down, not per request. If a service genuinely needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the runtime. This is strictly about **runtime teardown** — mutations still fan out to the topic DO via `executionCtx.waitUntil(...)` (from `yield* Cloudflare.WorkerExecutionContext`) so the live fan-out doesn't block the response.

## Where the `runtime.runPromise` idiom still lives

The `LLMS.md` "one ManagedRuntime + `runtime.runPromise` from non-Effect callbacks" idiom remains exactly where a real non-Effect callback boundary remains:

- **The differential oracle's v1 baseline** (`FateExecutor` in the package, [fate-effect-compiler.md](./fate-effect-compiler.md)): fate's compiled `(args) => Promise` resolvers demand a runner — the package's single conversion point, pinned by the enumeration test in `Executor.test.ts`.
- **The Node T2 harness** (`runFateOp`): a per-op runtime runs the interpreter program and is disposed.

The deployed worker has neither — its conversion point is the platform layer's.

## One runtime, one layer set

- **worker-level (in the runtime, init-only)** — `Drizzle` + the feature services (`WorkerFateServices`) + the composed `FateServer`, built once per isolate, never disposed, shared with the routes via the context layer.
- **request-level (on the `FateRequestContext`)** — `currentUser` + `livePublisher`, provided onto each operation effect by the interpreter.

See [alchemy-http-router.md](./alchemy-http-router.md) for where each is provided.

## See also

- [fate-effect-interpreter.md](./fate-effect-interpreter.md) — the serving path the route yields
- [fate-effect-compiler.md](./fate-effect-compiler.md) — the oracle-baseline compile step (where the package's one runner lives)
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — the worker-side composition (`config.ts`/`layers.ts`/`route.ts`)
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, folded into the one runtime
- [alchemy-worker.md](./alchemy-worker.md) — where the runtime is built in worker init
- [alchemy-http-router.md](./alchemy-http-router.md) — where the per-request pair is built
- [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) / [ADR 0043](../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md) — the runtime decisions
