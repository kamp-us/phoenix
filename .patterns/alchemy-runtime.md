# The runtime

How domain services get from the worker into a fate resolver. The short answer: there is **no _per-request_ `ManagedRuntime`** — there is exactly ONE _worker-level_ `ManagedRuntime`, built once per isolate in the worker init and never disposed (the CF deviation, below). The worker provides `Drizzle` and the feature services as worker-level layers folded into that runtime; per request the route builds only the two genuinely per-request VALUES — `Auth` and `LiveBus` — and hands fate a `FateContext` carrying `{runtime, request, auth, liveBus}`. The bridge runs each resolver with `ctx.runtime.runPromiseExit(...)`, providing `Auth`/`LiveBus` onto the effect. Nothing is built or disposed per request.

This is the doc to read before touching the seam between fate and the domain. It is the biggest departure from the old per-request-runtime design — and from the over-corrected zero-runtime design that briefly preceded it (ADR 0041, supersedes 0029).

## One worker-level runtime — not zero, not per-request

phoenix has had three runtime shapes; ADR 0041 records why the third is the right one:

- **The old per-request runtime** (`worker/features/fate/runtime.ts`) built a fresh `ManagedRuntime` on every `/fate` request and disposed it in `finally`. That was necessary because every binding came from a per-request `env`, so *everything* was request-scoped.
- **The zero-runtime correction** (ADR 0029) removed it: `Cloudflare.D1Connection.bind(PhoenixDb)` resolves **once per isolate**, so `Drizzle` and the features are isolate-stable and were provided as worker-level layers, then captured into a `Context` and run on the *default* runtime via `Effect.runPromiseExit(Effect.provide(effect, ctx.context))`. But that over-corrected: running on the default runtime put each resolver's spans on a **detached root** instead of nesting them under the request (F4).
- **The current shape** (ADR 0041): build ONE `ManagedRuntime` per isolate from the worker layers, and run every resolver THROUGH it. The runtime is the seam that both holds the worker singletons AND nests resolver spans under the request span — F4 — while still building nothing per request.

So the things built once per isolate are folded into the runtime:

- **Worker-level (folded into the one runtime):** `Drizzle`, and every feature service that depends only on it — `Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats` (the `WorkerFateServices`).
- **Request-level (provided onto each resolver effect):** `Auth` (the validated session) and `LiveBus` (the publish capability, ADR 0039). These genuinely vary per call, and ride the `FateContext` as VALUES — not folded into the runtime.

## Building the one runtime in init

The worker init builds the runtime from the zero-arg `makeFateLayer` (its `R` is `Database | BetterAuth`, both resolved once in init and provided here), with a shared `memoMap` so layer memoization stays correct across the runtime and the route-context layer derived from it:

```ts
// worker/index.ts
Effect.gen(function* () {
  const raw = yield* Database;
  const databaseLayer = Layer.succeed(Database)(raw);
  const betterAuth = yield* BetterAuth.BetterAuth;
  const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)(betterAuth);

  // ── THE ONE WORKER-LEVEL RUNTIME (ADR 0041) ──
  const appMemoMap = Layer.makeMemoMapUnsafe();
  const fateRuntime = ManagedRuntime.make(
    makeFateLayer.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
    {memoMap: appMemoMap},
  );

  // Share the runtime's already-built context with the routes (below).
  const fateLayer = Layer.effectContext(fateRuntime.contextEffect);

  const AppLive = makeAppLive({fateLayer, fateRuntime, /* … */});
  return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
});
```

`makeFateLayer` is the zero-arg worker layer constant (`features/fate/layers.ts`); the layer graph itself (mergeAll / provide / provideMerge) is exactly the one in [effect-layer-composition.md](./effect-layer-composition.md) — only *where* it's provided moved, into the one runtime built here.

### The runtime is the documented integration seam

This is not a phoenix invention. effect-smol's `LLMS.md` ("Integrating Effect into existing applications" section, with the `ai-docs/src/03_integration/10_managed-runtime.ts` example) describes exactly this shape: build one `ManagedRuntime` from your application's layers, then call `runtime.runPromise*` from each non-Effect callback. fate's `(args) => Promise` resolvers ARE that non-Effect callback boundary, so the runtime here is a faithful application of the documented idiom. The bridge is a **framework seam born in-app**, documented as a pattern but kept app-local under `worker/` — it has not graduated to a shared package (ADR 0040 Gate B unmet).

### CF deviation — never dispose

The `LLMS.md` example disposes the runtime on `SIGINT`/`SIGTERM`. A Cloudflare Worker isolate **has no shutdown hook**, so phoenix never calls `fateRuntime.dispose()`: the runtime lives for the isolate's lifetime, and Drizzle/D1 holds no poolable socket to release, so there is nothing leaked by not disposing. This is the one deliberate departure from the documented pattern, grounded in the platform — recorded in [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md).

## Sharing the built context with the routes — `Layer.effectContext`

Some routes (`Pasaport` in the `/fate` handler) `yield*` a worker service directly, outside the bridge. They must see the **same** singletons the runtime carries — not a second copy. `Layer.effectContext(fateRuntime.contextEffect)` derives a route layer from the runtime's already-built `Context<WorkerFateServices>`:

```ts
// worker/index.ts
const fateLayer = Layer.effectContext(fateRuntime.contextEffect);
```

`contextEffect` resolves the runtime's built context; wrapping it as a layer reuses those exact instances instead of rebuilding the layer per request. So `Drizzle` and the feature services are built a single time and SHARED by both the bridge runtime and the routes — one `memoMap` (passed at `ManagedRuntime.make`) keeps that sharing consistent.

## Request-level values, built in the route

`Auth` and `LiveBus` are the only per-request services. The `/fate` handler validates the session through the worker-level `Pasaport` (already in scope, no throwaway runtime — this is in place of the old `validateSessionCookie`), builds the two VALUES, and hands fate a `FateContext`:

```ts
// worker/features/fate/route.ts (mounted by the router — alchemy-http-router.md)
export const makeHandleFate = (runtime: WorkerRuntime) =>
  Effect.gen(function* () {
    const raw = yield* Cloudflare.Request;
    const pasaport = yield* Pasaport;                 // worker-level service
    const session = yield* pasaport.validateSession(raw.headers);

    const ctx: FateContext = {
      runtime,
      request: raw,
      auth: {user: session?.user, session: session?.session},
      liveBus: liveBusFor(publisher),                 // ADR 0039 publish capability
    };

    const res = yield* Effect.promise(() => fateServer.handleRequest(raw, ctx));
    return HttpServerResponse.fromWeb(res);
  });
```

The runtime is a **constructor argument** (`makeHandleFate(runtime)`), so the route holds no module-level runtime — `index.ts` is the single construction + ownership point. There is **no `Effect.context<FateEnv>()` capture and no per-request layer build**: the worker singletons live in the runtime, and `Auth`/`LiveBus` ride the `FateContext` as values.

## The bridge runs each resolver through the runtime

`FateContext` carries the `ManagedRuntime` plus the two per-request values. The low-level runner provides `Auth`/`LiveBus` onto the effect and runs it on `ctx.runtime`:

```ts
// worker/features/fate/context.ts
import type * as ManagedRuntime from "effect/ManagedRuntime";
export interface FateContext<R = WorkerFateServices> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly request: Request;
  readonly auth: typeof Auth.Service;
  readonly liveBus: typeof LiveBus.Service;
}
```

```ts
// worker/features/fate/effect.ts
import {Cause, Effect, Exit, Option} from "effect";
import {FateRequestError} from "@nkzw/fate/server";
import {LiveBus} from "../fate-live/event-bus";
import {Auth} from "../pasaport/Auth";
import {encodeFateError} from "./errors";

const runEffect = <A, R>(
  ctx: FateContext<R>,
  effect: Effect.Effect<A, unknown, R | Auth | LiveBus>,
): Promise<A> =>
  ctx.runtime
    .runPromiseExit(
      effect.pipe(
        Effect.provideService(Auth, ctx.auth),
        Effect.provideService(LiveBus, ctx.liveBus),
      ),
      {signal: ctx.request.signal},  // abort signal interrupts the resolver fiber
    )
    .then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      return Option.match(Cause.findErrorOption(exit.cause), {
        onSome: (e) => {
          throw e instanceof FateRequestError ? e : encodeFateError(e);
        },
        onNone: () => {
          throw encodeFateError(Cause.squash(exit.cause));
        },
      });
    });
```

The full runner — the helper family, the F7 cast, the `findErrorOption`/`Option.match` error unwind, the abort signal — is documented in [fate-effect-bridge.md](./fate-effect-bridge.md). The key fact here is the run boundary: `ctx.runtime.runPromiseExit(...)` is the only place a runtime is run, so resolver spans nest under the runtime's request span (F4) and `Auth`/`LiveBus` are provided per resolver while the worker singletons come from the runtime.

> **The runtime carries the worker FiberRefs too.** Because resolvers run THROUGH `ctx.runtime` (not a fresh default-runtime root), the runtime's logger, tracer, current span, and log level/annotations ARE in scope — that is precisely how resolver spans nest under the request span (F4). This is the win the old `Effect.runPromiseExit(Effect.provide(...))` default-runtime path gave up. phoenix has ~59 `Effect.fn(...)`-traced functions; once a Tracer/exporter is installed at worker scope, those spans will be live children of the request with no further bridge change. Today no exporter is installed, so the spans are inert — but the nesting structure is already correct.

> **No `dispose`, no `try/finally`, no `waitUntil` for runtime teardown.** The runtime is built once and never disposed (CF has no shutdown hook); the worker-level layers are released when the isolate is torn down, not per request. If a service genuinely needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the runtime. This is strictly about **runtime teardown** — it is not "no `waitUntil` anywhere." Mutations still fan out to the topic DO via `executionCtx.waitUntil(...)` so the work doesn't block the response; on alchemy that handle comes from `yield* Cloudflare.WorkerExecutionContext` (a service whose value is the CF `ExecutionContext`). The live fan-out `waitUntil` is a separate, still-required concern.

## One runtime, one layer set

phoenix's old design ran a per-request `ManagedRuntime`; the brief correction ran none. Now there is a single isolate-level runtime over one `Drizzle`:

- **worker-level (in the runtime)** — `Drizzle` + the feature services (`WorkerFateServices`), built once per isolate, never disposed.
- **request-level (on the `FateContext`)** — `Auth` + `LiveBus`, provided onto each resolver effect by the bridge.

`Drizzle` and the feature services are built once at worker init and folded into the runtime; the `/fate` route builds `Auth`/`LiveBus` per request and the bridge provides them onto each resolver effect with `Effect.provideService`. See [alchemy-http-router.md](./alchemy-http-router.md) for where each is provided.

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — the bridge this doc describes (runs each resolver through `ctx.runtime`)
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, folded into the one runtime
- [alchemy-worker.md](./alchemy-worker.md) — where the runtime is built in worker init
- [alchemy-http-router.md](./alchemy-http-router.md) — where `Auth`/`LiveBus` are built per request
- [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) — the worker-level `ManagedRuntime` decision (supersedes 0029)
