# Server wiring

How the backend is assembled and mounted. The short answer: `createFateServer({context, roots, queries, lists, mutations, sources})` produces a server with plain `Request → Response` handlers; the Hono route owns the per-request `ManagedRuntime` — it builds it, hands it to fate as the adapter context, and disposes it when the request ends.

## The per-request runtime

The runtime composes the feature layers over `Drizzle` over per-request values — the layer graph in [effect-layer-composition.md](./effect-layer-composition.md). It lives at `worker/fate/runtime.ts`:

```ts
// worker/fate/runtime.ts
export namespace FateRuntime {
  export type Context =
    | CloudflareEnv | RequestContext | Auth
    | Drizzle | Pasaport | Vote | Sozluk | Pano | Stats;
  export const make = (env: Env, request: Request, sessionData: SessionData) =>
    ManagedRuntime.make(layer(env, request, sessionData));
}
```

`sessionData` is resolved once per request (validate the session, then build the runtime with it baked into the `Auth` layer), so resolvers read the caller with `yield* Auth.required`.

## The Hono route owns the runtime

The route builds the runtime, passes it through `adapterContext`, and disposes it in `finally` via the Worker `ExecutionContext` so disposal doesn't block the response. fate's `context` factory just reads what the route built:

```ts
// worker/fate/server.ts
export const fateServer = createFateServer<FateContext>({
  context: ({adapterContext}) => adapterContext,   // route supplies {runtime, request}
  roots: Root,           // list/byId roots (from views.ts)
  queries,               // {me, health, term, post, profile, landingStats, …} via fateQuery
  lists,                 // {terms, posts} via fateList — see fate-connections.md
  mutations,             // {"definition.add", …} via fateMutation — see fate-mutations.md
  sources,               // hand-built Effect-backed SourceResolver — see fate-sources.md
});
```

```ts
// worker/index.ts
app.post("/fate", async (c) => {
  const sessionData = await validateSession(c.env, c.req.raw);
  const runtime = FateRuntime.make(c.env, c.req.raw, sessionData);
  try {
    return await fateServer.handleRequest(c.req.raw, {request: c.req.raw, runtime});
  } finally {
    c.executionCtx.waitUntil(runtime.dispose());
  }
});
```

The fate routes sit in `worker/index.ts` alongside `/api/*`, `/api/auth/*`, `/agents/*`, and the dev-only `/api/admin/*` routes. `createFateServer`'s handlers operate on standard `Request`/`Response`, so they drop onto a Hono route directly.

> **Why the route owns the runtime, not fate's `context`.** `context` has no symmetric teardown hook. Building the runtime in the route gives a `try/finally` to dispose it deterministically — one `ManagedRuntime` per request, disposed after the response, no leak.

## Live route

```ts
app.all("/fate/live", (c) => fateServer.handleLiveRequest(c.req.raw, c));
```

A live request is a long-lived SSE stream, so its runtime must outlive a single request — it is **not** disposed in a `finally`. phoenix does not enable live views (the built-in event bus is single-isolate in-memory); the route exists for when a Durable-Object-backed `LiveEventBus` is added. See [fate-mutations.md](./fate-mutations.md).

## Codegen

fate's codegen reads the server's exported types and manifest and emits the client wiring (the `react-fate/client` module). The server is the single source of truth for types — the client imports `Entity<>` types (type-only) from `worker/fate/views.ts`, and there is no schema artifact or SDL fetch step to keep in sync. Wire `fate generate` (or its Vite plugin) into the client build.

## The admin runtime stays separate

The admin runtime (`worker/admin/runtime.ts`, ADR 0012) is independent: the dev-only `/api/admin/*` routes use `AdminRuntime.make(env)` directly. fate owns only the request runtime. See [effect-layer-composition.md](./effect-layer-composition.md).

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — `FateContext` and the helpers `queries`/`mutations` use
- [fate-sources.md](./fate-sources.md) — the `sources` resolver
- [fate-data-views.md](./fate-data-views.md) — the `roots`/`Root` map
- [effect-layer-composition.md](./effect-layer-composition.md) — the runtime layer graph
- ADR 0012 — the separate admin runtime
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/server.ts`, docs `docs/guide/server-integration.md`
