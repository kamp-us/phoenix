# The runtime

How domain services get from the worker into a fate resolver. The short answer: there is **no per-request `ManagedRuntime`**. The worker provides `Drizzle` and the feature services as **worker-level layers** (built once, in init). Per request the route provides only `Auth` and `RequestContext`, then captures the live service map with `Effect.context<R>()` and hands it to fate. The bridge runs each resolver with `Effect.runPromiseExit(Effect.provide(effect, ctx.context))`. Nothing is disposed.

This is the doc to read before touching the seam between fate and the domain. It is the biggest departure from the old per-request-runtime design.

## Why there is no per-request runtime

The old `worker/fate/runtime.ts` built a fresh `ManagedRuntime` on every `/fate` request and disposed it in `finally`. That was necessary because every binding came from a per-request `env`, so *everything* — `Drizzle`, the features — was request-scoped.

On alchemy that premise is gone. `Cloudflare.D1Connection.bind(PhoenixDb)` resolves **once per isolate** in the worker's init phase, and the bound `db` is stable for the isolate's life. So the things built on it are stable too:

- **Worker-level (built once, in init):** `Drizzle`, and every feature service that depends only on `Drizzle` — `Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`.
- **Request-level (provided per request):** `Auth` (the validated session) and `RequestContext` (headers/url/method). These genuinely vary per call.

## Worker-level layers, built in init

Construct the capability and feature layers from the bound clients, and provide them onto the worker body so they're in scope for every request:

```ts
// worker/index.ts
Effect.gen(function* () {
  const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);

  // Drizzle is built from the bound D1 client (see alchemy-drizzle-d1.md),
  // not from a per-request env. One instance for the isolate.
  const DrizzleLive = makeDrizzleLayer(db);

  const FeatureLive = Layer.mergeAll(SozlukLive, PanoLive, StatsLive, PasaportLive).pipe(
    Layer.provideMerge(VoteLive),
    Layer.provide(DrizzleLive),
  );

  return {fetch: buildRouter({connections, topics}).pipe(HttpRouter.toHttpEffect)};
}).pipe(
  Effect.provide(/* DrizzleLive + FeatureLive are provided here, at worker scope */),
)
```

The layer graph itself (mergeAll / provide / provideMerge) is exactly the one in [effect-layer-composition.md](./effect-layer-composition.md) — only *where* it's provided moves, from a per-request `ManagedRuntime` to the worker body.

## Request-level values, provided in the route

`Auth` and `RequestContext` are provided inside the `/fate` handler, around the work that needs them:

```ts
// worker/fate/route.ts (mounted by the router — alchemy-http-router.md)
const handleFate = Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;                 // the raw cf.Request
  const session = yield* Pasaport.validateSession(raw.headers);  // worker-level service

  return yield* serveFate(raw).pipe(
    Effect.provideService(Auth, {user: session?.user, session: session?.session}),
    Effect.provideService(RequestContext, requestContextOf(raw)),
  );
});
```

`Pasaport` is already in scope (worker-level), so session validation needs no special runtime — it's just a `yield*`. This is in place of the old `validateSessionCookie` building its own throwaway `ManagedRuntime`.

## Capturing the service map for fate

fate's `handleRequest` is async — it calls resolver callbacks that must bridge back into Effect. They need the live services. Capture them with `Effect.context<R>()` and pass the map through `adapterContext`:

> **API names (effect v4).** The capture/provide/type names the worker uses are:
> - capture the service map → **`Effect.context<R>()`**
> - provide a captured map → **`Effect.provide(effect, ctx)`**
> - the service-map type → **`Context.Context<R>`** from `effect/Context`
>
> (An earlier effect line named these `Effect.services` / `Effect.provideServices` / `ServiceMap.ServiceMap` from `effect/ServiceMap`; the implemented worker — `worker/fate/route.ts`, `context.ts`, `effect.ts` — uses the v4 names above.)

```ts
const serveFate = (raw: Request) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FateEnv>();  // Context of everything in scope
    const res = yield* Effect.promise(() =>
      fateServer.handleRequest(raw, {request: raw, context}),
    );
    return HttpServerResponse.fromWeb(res);
  });
```

At the point of capture, the context holds the worker-level services (`Drizzle`, features) *and* the request-level services (`Auth`, `RequestContext`) provided just above — so `context` carries the full `FateEnv`.

`FateEnv` is the union of every service a resolver may touch:

```ts
type FateEnv = Drizzle | Sozluk | Pano | Vote | Pasaport | Stats | Auth | RequestContext;
```

## The bridge runs with the captured map

`FateContext` carries a captured `Context` (effect v4's service map), not a `ManagedRuntime`. The low-level runner provides the map and runs on the default runtime:

```ts
// worker/fate/context.ts
import type * as Context from "effect/Context";
export interface FateContext {
  readonly context: Context.Context<FateEnv>;
  readonly request: Request;
}
```

```ts
// worker/fate/effect.ts
import {Cause, Effect, Exit} from "effect";
import {FateRequestError} from "@nkzw/fate/server";
import {encodeFateError} from "./errors";

const runEffect = <A>(
  ctx: FateContext,
  effect: Effect.Effect<A, unknown, FateEnv>,
): Promise<A> =>
  Effect.runPromiseExit(Effect.provide(effect, ctx.context)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const found = Cause.findError(exit.cause);
    if (found._tag === "Success") {
      const e = found.success;
      if (e instanceof FateRequestError) throw e;
      throw encodeFateError(e);
    }
    throw encodeFateError(Cause.squash(exit.cause));
  });
```

This is the **only** change to the bridge from [fate-effect-bridge.md](./fate-effect-bridge.md): `ctx.runtime.runPromiseExit(effect)` becomes `Effect.runPromiseExit(Effect.provide(effect, ctx.context))`. The helper family (`fateQuery`/`fateList`/`fateMutation`/`fateSource`), the error mapping, the "no `runPromise` in feature code" rule — all unchanged.

> **`Effect.context` captures the service map (Context), not FiberRefs.** It carries the worker-level and request-level *services* — it does not carry the worker fiber's logger, tracer, current span, log level/annotations, or `Scope`. And `Effect.runPromiseExit(Effect.provide(...))` starts a fresh root fiber on the **default runtime**, so none of those FiberRefs are inherited. This is not a regression: the old `ctx.runtime.runPromiseExit(effect)` also ran a fresh fiber per resolver, so the behaviour is identical. The consequence to remember is forward-looking — if we ever install a Tracer/logger at worker scope, the bridge must re-establish the span and logger explicitly (resolver spans would otherwise be detached roots, not children of the request). There is nothing to re-establish today: phoenix has ~59 `Effect.fn(...)`-traced functions but **no Tracer or exporter installed**, so those spans are inert. Do not treat `Effect.fn` spans or any observability as load-bearing yet.

> **No `dispose`, no `try/finally`, no `waitUntil` for teardown.** Providing a captured service map and running on the default runtime allocates nothing that needs scoped cleanup. The worker-level layers are released when the isolate is torn down, not per request. If a service genuinely needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the whole runtime. This is strictly about **runtime teardown** — it is not "no `waitUntil` anywhere." Mutations still fan out to the topic DO via `executionCtx.waitUntil(...)` so the work doesn't block the response; on alchemy that handle comes from `yield* Cloudflare.WorkerExecutionContext` (a service whose value is the CF `ExecutionContext`), not from a disposed runtime. The live fan-out `waitUntil` is a separate, still-required concern.

## The two-runtime story becomes two layer sets

phoenix keeps the request/admin split (ADR 0012), but it's no longer two `ManagedRuntime`s — it's two layer sets over the same worker:

- **request** — `Auth` + `RequestContext` + the feature services. Drives `/fate`.
- **admin** — `AdminAuth` + the `…Admin` services, env-gated, no session. Drives the dev-only `/api/admin/*` routes.

Both sit on the same worker-level `Drizzle`. The admin routes provide `AdminAuth` the same way `/fate` provides `Auth`: `Effect.provideService` in the handler. See [alchemy-http-router.md](./alchemy-http-router.md) for where each is provided.

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — the bridge this doc describes (a captured service map for the old `ManagedRuntime`)
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, now provided at worker scope
- [alchemy-worker.md](./alchemy-worker.md) — where worker-level layers are provided
- [alchemy-http-router.md](./alchemy-http-router.md) — where `Auth`/`RequestContext`/`AdminAuth` are provided per request
- [ADR 0012](../.decisions/0012-admin-parallel-services.md) — the request/admin split
