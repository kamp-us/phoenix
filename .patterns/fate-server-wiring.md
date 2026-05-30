# Server wiring

How the backend is assembled and mounted. The short answer: `createFateServer({context, roots, queries, lists, mutations, sources, live})` produces a server with plain `Request → Response` handlers; the `POST /fate` route owns the per-request seam — it validates the session through the worker-level `Pasaport`, provides `Auth` for the request, captures the live service map with `Effect.context<FateEnv>()`, and hands it to fate through `adapterContext`. No per-request `ManagedRuntime` is built or disposed (ADR 0029).

> This doc has been rewritten against the post-alchemy source under `apps/web/worker/features/fate/`. The earlier shape (`FateRuntime.make`, `sessionData` baked into a per-request runtime, Hono `try/finally` dispose) is gone — read [alchemy-runtime.md](./alchemy-runtime.md) and [alchemy-http-router.md](./alchemy-http-router.md) for the current runtime model.

## Worker-level layers, built once

The data plane is composed at worker init from `makeFateLayer(db, auth)` (`features/fate/layers.ts`) and provided onto the worker body. The result Layer is `Layer.Layer<WorkerFateServices>` — `Drizzle`, `Pasaport`, `Vote`, `Sozluk`, `Pano`, `Stats`, all resolved once per isolate. Per-request services (`Auth`, `HttpServerRequest`) are layered on top inside the `/fate` route, not here. See [effect-layer-composition.md](./effect-layer-composition.md) for the layer graph and [alchemy-runtime.md](./alchemy-runtime.md) for the worker-level/per-request split.

## The `/fate` route is the per-request seam

The route — `handleFate` in `features/fate/route.ts`, mounted via `HttpRouter.add("POST", "/fate", handleFate)` — does four things, in order:

1. Reads the raw `Request` via `Cloudflare.Request` and the `ExecutionContext` via `Cloudflare.WorkerExecutionContext`.
2. Validates the session through the worker-level `Pasaport` — `yield* Pasaport`, then `pasaport.validateSession(raw.headers)`. No throwaway runtime; this replaces the pre-alchemy `validateSessionCookie` helper.
3. Sets up the per-request live publisher (the `AsyncLocalStorage` `livePublishContext`, see [fate-live-views.md](./fate-live-views.md)) over `executionCtx.waitUntil` so a mutation's `live.*` fan-out reaches the topic DO without blocking the response.
4. Captures the live service map with `Effect.context<FateEnv>()` and hands it to fate as `adapterContext: {context, request}`. The captured `Context` carries the worker-level services plus the per-request `Auth` (provided just below) plus the upstream `HttpServerRequest` Tag the alchemy/HttpRouter runtime already provides — so it's the full `FateEnv`.

```ts
// features/fate/route.ts (the shape, abridged)
export const handleFate = Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;
  const executionCtx = yield* Cloudflare.WorkerExecutionContext;
  const pasaport = yield* Pasaport;
  const session = yield* pasaport.validateSession(raw.headers);

  const publisher = /* … executionCtx.waitUntil over liveTopics.publish … */;

  const res = yield* Effect.gen(function* () {
    const context = yield* Effect.context<FateEnv>();
    return yield* Effect.promise(() =>
      livePublishContext.run(publisher, () =>
        fateServer.handleRequest(raw, {request: raw, context}),
      ),
    );
  }).pipe(
    Effect.provideService(Auth, {user: session?.user, session: session?.session}),
  );

  return HttpServerResponse.fromWeb(res);
});

export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
```

`FateContext` (`features/fate/context.ts`) is just `{context: Context.Context<FateEnv>; request: Request}` — no `ManagedRuntime`, no `sessionData`. Session is read by resolvers as `yield* Auth.required`, not off the context.

## The bridge runs each resolver with the captured map

`features/fate/effect.ts` is the only place an Effect is run. The helper family (`fateQuery`, `fateList`, `fateMutation`, `fateSource`) wraps generators into the plain-async functions fate expects, and `runEffect` discharges:

```ts
const runEffect = <A>(ctx: FateContext, effect: Effect.Effect<A, unknown, FateEnv>): Promise<A> =>
  Effect.runPromiseExit(Effect.provide(effect, ctx.context)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    // … Cause.findError → encodeFateError → throw …
  });
```

This is the single change to the bridge from the pre-alchemy shape: `ctx.runtime.runPromiseExit(effect)` became `Effect.runPromiseExit(Effect.provide(effect, ctx.context))`. The resolver's `R = never` after the provide, because the captured `Context` carries the full `FateEnv`. See [fate-effect-bridge.md](./fate-effect-bridge.md).

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

`/fate/live` does **not** go through `fateServer.handleLiveRequest`. The SSE stream and fan-out live in the `ConnectionDO` Durable Object so they cross isolates. The route (`features/fate-live/route.ts`) authenticates through `Pasaport` and hands the request off to a `ConnectionDO` instance via `LiveConnections.open(connectionId, request)` — the DO's `fetch` opens the SSE stream and registers with the matching `TopicDO`s. No per-request runtime work happens in the route. See [fate-live-views.md](./fate-live-views.md) for the DO design and [alchemy-modular-do-with-sibling-resolution.md](./alchemy-modular-do-with-sibling-resolution.md) for the modular DO pattern the two live DOs use ([ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)).

## The admin layer set stays separate

The admin services (`SozlukAdmin`, `PanoAdmin`, `PasaportAdmin`) are built by `makeAdminLayer(db)` (`features/fate/layers.ts`) and drive the dev-only `/api/admin/*` seeders. Same `Drizzle` as the fate data plane, different surface (ADR 0012). On alchemy this is **two layer sets over one worker**, not two `ManagedRuntime`s (ADR 0029). The admin routes provide `AdminAuth` (the env gate) per route, the way `/fate` provides `Auth`. See [alchemy-http-router.md](./alchemy-http-router.md).

## Codegen

The **fate Vite plugin** generates the client wiring (the `react-fate/client` module) at build time from the server's exported types and manifest — no hand-run `fate generate`, nothing to commit. The server is the single source of truth for types: the client imports `Entity<>` types (type-only) from `worker/features/fate/views.ts`, and there is no schema artifact or SDL fetch step to keep in sync. The plugin lives in `vite.config.ts`. See [ADR 0022](../.decisions/0022-server-types-single-source-of-truth.md).

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — `FateContext`, the bridge helpers, error mapping
- [alchemy-runtime.md](./alchemy-runtime.md) — the worker-level / per-request layer split this doc is built on
- [alchemy-http-router.md](./alchemy-http-router.md) — where `Auth` / `AdminAuth` are provided per route
- [effect-layer-composition.md](./effect-layer-composition.md) — the layer graph, provided at worker scope
- [fate-sources.md](./fate-sources.md) — the `sources` resolver
- [fate-data-views.md](./fate-data-views.md) — the `roots`/`Root` map (declared in `views.ts`)
- [ADR 0029](../.decisions/0029-worker-runtime-servicemap.md) — supersedes ADR 0017 (the old "Hono route owns the runtime" shape this doc used to describe)
- [ADR 0012](../.decisions/0012-admin-parallel-services.md) — the request/admin split
