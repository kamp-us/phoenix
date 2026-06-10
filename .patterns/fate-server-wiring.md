# Server wiring

How the backend is assembled and mounted. The short answer: `createFateServer({context, roots, queries, lists, mutations, sources, live})` produces a server with plain `Request → Response` handlers; the `POST /fate` route owns the per-request seam — it validates the session through the worker-level `Pasaport`, builds the two genuinely per-request VALUES (`Auth` and `LiveBus`), and hands fate a `FateContext` of `{runtime, request, auth, liveBus}` through `adapterContext`. The runtime it carries is the ONE worker-level `ManagedRuntime`, built once per isolate; nothing is built or disposed per request (ADR 0041, supersedes 0029).

> This doc has been rewritten against the post-alchemy source under `apps/web/worker/features/fate/`. The pre-alchemy shape (`FateRuntime.make`, `sessionData` baked into a per-request runtime, Hono `try/finally` dispose) is gone, and so is the brief zero-runtime correction (a captured `Context` run on the default runtime) that ADR 0029 described — read [alchemy-runtime.md](./alchemy-runtime.md) and [alchemy-http-router.md](./alchemy-http-router.md) for the current worker-level `ManagedRuntime` model (ADR 0041).

## Worker-level layers, built once

The data plane is composed at worker init from the zero-arg `makeFateLayer` (`features/fate/layers.ts`) and folded into the one worker-level `ManagedRuntime`. The layer is `Layer.Layer<WorkerFateServices, never, Database | BetterAuth>` — `Drizzle`, `Pasaport`, `Vote`, `Sozluk`, `Pano`, `Stats`, all resolved once per isolate (its `Database | BetterAuth` requirements are resolved once in init and provided when the runtime is built). Per-request services (`Auth`, `LiveBus`) are not layered here — the bridge provides them onto each resolver effect at run time. See [effect-layer-composition.md](./effect-layer-composition.md) for the layer graph and [alchemy-runtime.md](./alchemy-runtime.md) for the worker-level/per-request split.

## The `/fate` route is the per-request seam

The route — `makeHandleFate(runtime)` in `features/fate/route.ts`, mounted via `makeFateRoute(runtime)` (`HttpRouter.add("POST", "/fate", makeHandleFate(runtime))`) — does four things, in order:

1. Reads the raw `Request` via `Cloudflare.Request` and the `ExecutionContext` via `Cloudflare.WorkerExecutionContext`.
2. Validates the session through the worker-level `Pasaport` — `yield* Pasaport`, then `pasaport.validateSession(raw.headers)`. No throwaway runtime; this replaces the pre-alchemy `validateSessionCookie` helper. (`Pasaport` is yielded directly here, outside the bridge, so it must be the SAME singleton the runtime carries — the route gets it from the runtime's built context via `Layer.effectContext`, see [alchemy-runtime.md](./alchemy-runtime.md).)
3. Sets up the per-request live publisher over `executionCtx.waitUntil` so a mutation's `live.*` fan-out reaches the topic DO without blocking the response. There is no `AsyncLocalStorage` bridge (ADR 0039): the publish capability rides the `FateContext` as `liveBus`, built from this publisher with `liveBusFor(publisher)`.
4. Builds the two genuinely per-request VALUES — `auth` (the validated session) and `liveBus` (the publish capability) — and hands fate a `FateContext` of `{runtime, request, auth, liveBus}` as `adapterContext`. The `runtime` is the worker-level `ManagedRuntime` passed into the route; the bridge provides `auth`/`liveBus` onto each resolver effect and runs it on `runtime`. There is no `Effect.context<FateEnv>()` capture.

```ts
// features/fate/route.ts (the shape, abridged)
export const makeHandleFate = (runtime: WorkerRuntime) =>
  Effect.gen(function* () {
    const raw = yield* Cloudflare.Request;
    const executionCtx = yield* Cloudflare.WorkerExecutionContext;
    const pasaport = yield* Pasaport;
    const session = yield* pasaport.validateSession(raw.headers);

    const publisher = /* … executionCtx.waitUntil over liveTopics.publish … */;

    const ctx: FateContext = {
      runtime,
      request: raw,
      auth: {user: session?.user, session: session?.session},
      liveBus: liveBusFor(publisher),
    };

    const res = yield* Effect.promise(() => fateServer.handleRequest(raw, ctx));
    return HttpServerResponse.fromWeb(res);
  });

export const makeFateRoute = (runtime: WorkerRuntime) =>
  HttpRouter.add("POST", "/fate", makeHandleFate(runtime));
```

`FateContext` (`features/fate/context.ts`) is `{runtime, request, auth, liveBus}` — the worker-level `ManagedRuntime` plus the two per-request VALUES, no captured `Context` and no `sessionData`. Session is read by resolvers as `yield* Auth.required`, not off the context. The runtime is a **constructor argument** (`makeHandleFate(runtime)`), so the route holds no module-level runtime — `index.ts` is the single construction + ownership point.

## The bridge runs each resolver through the runtime

`features/fate/effect.ts` is the only place an Effect is run. The helper family (`fateQuery`, `fateList`, `fateMutation`, `fateSource`) wraps generators into the plain-async functions fate expects, and `runEffect` discharges:

```ts
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
      {signal: ctx.request.signal},
    )
    .then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      // … Cause.findErrorOption → encodeFateError → throw …
    });
```

This is the key change from both prior shapes: the resolver runs THROUGH the worker-level runtime with `ctx.runtime.runPromiseExit(...)` (not `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` on the default runtime), so its spans nest under the runtime's request span (the F4 win, ADR 0041). `Effect.provideService(Auth/LiveBus)` discharges the two per-request services, leaving exactly `R` — the runtime's own environment. See [fate-effect-bridge.md](./fate-effect-bridge.md).

## The fate server

`fateServer` (`features/fate/server.ts`) is a long-lived `createFateServer` instance — there is nothing per-request about it. Its `context` factory just reads what the route supplied:

```ts
export const fateServer = createFateServer<FateContext, /* … */>({
  context: ({adapterContext}) => {
    if (!adapterContext) throw new Error("fate adapterContext missing — the /fate route must supply it.");
    return adapterContext;
  },
  roots: {},        // empty on purpose — see comment in server.ts
  queries,          // from queries.ts
  lists,            // from lists.ts (see fate-connections.md)
  mutations,        // sozluk + pano + pasaport (see fate-mutations.md)
  sources,          // hand-built SourceResolver (see fate-sources.md)
  live: liveBusConfig,  // publish-only bus → TopicDO (see fate-live-views.md)
});
```

`createFateServer`'s `handleRequest` operates on standard `Request` / `Response`, so it drops straight into an `HttpRouter.add` route (ADR 0027 / [alchemy-http-router.md](./alchemy-http-router.md)). `roots` stays empty because every root query is a `query` resolver — keeping `roots` empty also keeps `fateServer`'s exported type nameable (TS2883).

## `runWorkerFirst` for `/fate` and `/fate/*`

The alchemy worker serves the SPA from `assets` with `notFoundHandling: "single-page-application"`, so any path *not* listed in `assets.config.runWorkerFirst` is handed to the asset server first. The asset server answers `GET /fate` with the SPA shell (200) but rejects `POST /fate` with 405 — and the worker route never runs. `apps/web/worker/index.ts` lists `/fate` and `/fate/*` in `runWorkerFirst`:

```ts
assets: {
  directory: "./dist/client",
  config: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api/*", "/fate", "/fate/*"],
  },
},
```

This ships to prod; integration tests using `SELF.fetch` bypass the asset layer, so they pass without this entry — verify `POST /fate` against the running worker, not only in tests.

## Live route

`/fate/live` does **not** go through `fateServer.handleLiveRequest`. The SSE stream and fan-out live in the unified `LiveDO` Durable Object so they cross isolates. The route (`features/fate-live/route.ts`) authenticates through `Pasaport` and hands the request off to a connection-role `LiveDO` instance via `LiveConnections.open(connectionId, request)` — the DO's `fetch` opens the SSE stream, and a subscribe control message registers it with the matching `topic:` instances. No per-request runtime work happens in the route. See [fate-live-views.md](./fate-live-views.md) for the protocol and [alchemy-durable-objects.md](./alchemy-durable-objects.md) for the unified DO pattern ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md)).

## Codegen

The **fate Vite plugin** generates the client wiring (the `react-fate/client` module) at build time from the server's exported types and manifest — no hand-run `fate generate`, nothing to commit. The server is the single source of truth for types: the client imports `Entity<>` types (type-only) from `worker/features/fate/views.ts`, and there is no schema artifact or SDL fetch step to keep in sync. The plugin lives in `vite.config.ts`. See [ADR 0022](../.decisions/0022-server-types-single-source-of-truth.md).

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — `FateContext`, the bridge helpers, error mapping
- [alchemy-runtime.md](./alchemy-runtime.md) — the worker-level / per-request layer split this doc is built on
- [alchemy-http-router.md](./alchemy-http-router.md) — where `Auth` is provided per route
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, provided at worker scope
- [fate-sources.md](./fate-sources.md) — the `sources` resolver
- [fate-data-views.md](./fate-data-views.md) — the `roots`/`Root` map (declared in `views.ts`)
- [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) — the worker-level `ManagedRuntime` (supersedes ADR 0029)
- [ADR 0029](../.decisions/0029-worker-runtime-servicemap.md) — the superseded captured-`Context` / default-runtime shape (history)
