# The runtime

How domain services get from the worker into a fate resolver. The short answer: there is **no per-request `ManagedRuntime`**. The worker provides `Drizzle` and the feature services as **worker-level layers** (built once, in init). Per request you provide only `Auth` and `RequestContext`, then capture the live service map with `Effect.services<R>()` and hand it to fate. The bridge runs each resolver with `Effect.runPromiseExit(Effect.provideServices(effect, services))`. Nothing is disposed.

This is the doc to read before touching the seam between fate and the domain. It is the biggest departure from how phoenix works today, and the right shape to build greenfield.

## Why the per-request runtime goes away

Today `worker/fate/runtime.ts` builds a fresh `ManagedRuntime` on every `/fate` request and disposes it in `finally`. That was necessary because every binding came from a per-request `env`, so *everything* — `Drizzle`, the features — was request-scoped.

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

`Pasaport` is already in scope (worker-level), so session validation needs no special runtime — it's just a `yield*`. This replaces today's `validateSessionCookie` building its own throwaway `ManagedRuntime`.

## Capturing the service map for fate

fate's `handleRequest` is async — it calls resolver callbacks that must bridge back into Effect. They need the live services. Capture them with `Effect.services<R>()` and pass the map through `adapterContext`:

```ts
const serveFate = (raw: Request) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<FateEnv>();  // ServiceMap of everything in scope
    const res = yield* Effect.promise(() =>
      fateServer.handleRequest(raw, {request: raw, services}),
    );
    return HttpServerResponse.fromWeb(res);
  });
```

At the point of capture, the context holds the worker-level services (`Drizzle`, features) *and* the request-level services (`Auth`, `RequestContext`) provided just above — so `services` carries the full `FateEnv`.

`FateEnv` is the union of every service a resolver may touch:

```ts
type FateEnv = Drizzle | Sozluk | Pano | Vote | Pasaport | Stats | Auth | RequestContext;
```

## The bridge runs with the captured map

`FateContext` carries a `ServiceMap`, not a `ManagedRuntime`. The low-level runner provides the map and runs on the default runtime:

```ts
// worker/fate/context.ts
import type * as ServiceMap from "effect/ServiceMap";
export interface FateContext {
  readonly services: ServiceMap.ServiceMap<FateEnv>;
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
  Effect.runPromiseExit(Effect.provideServices(effect, ctx.services)).then((exit) => {
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

This is the **only** change to the bridge from [fate-effect-bridge.md](./fate-effect-bridge.md): `ctx.runtime.runPromiseExit(effect)` becomes `Effect.runPromiseExit(Effect.provideServices(effect, ctx.services))`. The helper family (`fateQuery`/`fateList`/`fateMutation`/`fateSource`), the error mapping, the "no `runPromise` in feature code" rule — all unchanged.

> **No `dispose`, no `try/finally`, no `waitUntil` for teardown.** Providing a captured `ServiceMap` and running on the default runtime allocates nothing that needs scoped cleanup. The worker-level layers are released when the isolate is torn down, not per request. If a service genuinely needs per-request acquire/release (none do today), wrap *that* service in a `Scope`, not the whole runtime.

## The two-runtime story becomes two layer sets

phoenix keeps the request/admin split (ADR 0012), but it's no longer two `ManagedRuntime`s — it's two layer sets over the same worker:

- **request** — `Auth` + `RequestContext` + the feature services. Drives `/fate`.
- **admin** — `AdminAuth` + the `…Admin` services, env-gated, no session. Drives the dev-only `/api/admin/*` routes.

Both sit on the same worker-level `Drizzle`. The admin routes provide `AdminAuth` the same way `/fate` provides `Auth`: `Effect.provideService` in the handler. See [alchemy-http-router.md](./alchemy-http-router.md) for where each is provided.

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — the bridge this doc patches (`ServiceMap` for `ManagedRuntime`)
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, now provided at worker scope
- [alchemy-worker.md](./alchemy-worker.md) — where worker-level layers are provided
- [alchemy-http-router.md](./alchemy-http-router.md) — where `Auth`/`RequestContext`/`AdminAuth` are provided per request
- [ADR 0012](../.decisions/0012-admin-parallel-services.md) — the request/admin split
