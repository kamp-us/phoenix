# Layer composition and runtime wiring

How phoenix builds Effect runtimes from layers, per request. Read [effect-context-service.md](./effect-context-service.md) first.

## The three layer constructors

Effect ships three you'll actually use:

| Constructor | Use when |
|---|---|
| `Layer.succeed(Tag)(value)` | The service is a ready-made value. No deps, no construction effect. |
| `Layer.effect(Tag)(Effect)` | Service is built inside an Effect that may yield other services. Most common case in phoenix. |
| `Layer.effectContext(Effect)` | One Effect provides multiple services. Rare — only when you genuinely need to bind several tags from one construction (e.g. `@effect/sql-d1` binds `D1Client` + `SqlClient` together). |

There's `Layer.scoped` too, for services with finalizers (DB connections that need closing, file handles, etc.). Phoenix doesn't need it — the D1 binding is owned by Cloudflare, no cleanup required.

## Composing layers — `mergeAll` and `provide`

Two operators:

- **`Layer.mergeAll(L1, L2, L3, ...)`** — combines independent layers into one. The result provides everything `L1`, `L2`, `L3` provide. Use for *parallel* services that don't depend on each other.
- **`Layer.provide(layerNeedingDeps, layerProvidingDeps)`** — feeds one layer's output into another's input. Use for *layered* services where one depends on the other.

The phoenix runtime composition uses both:

```ts
const FeatureLayer = Layer.mergeAll(SozlukLive, PanoLive, VoteLive, PasaportLive);

const Live = FeatureLayer.pipe(
  Layer.provide(DrizzleLive),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(CloudflareEnv, env),
      Layer.succeed(RequestContext, {/* ... */}),
      Layer.succeed(Auth, {/* ... */}),
    ),
  ),
);
```

Read this inside-out:

1. `CloudflareEnv` + `RequestContext` + `Auth` are provided as plain values (per-request).
2. `Drizzle` needs `CloudflareEnv` — provided by the layer above.
3. `Sozluk`, `Pano`, `Vote`, `Pasaport` need `Drizzle` (and `Vote`-consumers need `Vote`) — provided by both layers above.

The result is `Layer<SozlukServices, never, never>` — `R` is `never`, meaning every dep is satisfied. Runnable.

### Direction of `Layer.provide`

`A.pipe(Layer.provide(B))` means: **B's outputs satisfy A's inputs.** The piped form reads "A, provided with B's services." Common confusion: it's not "provide A to B."

If `Sozluk` needs `Drizzle`:
- `SozlukLive.pipe(Layer.provide(DrizzleLive))` — correct. Drizzle satisfies Sozluk's needs.
- `DrizzleLive.pipe(Layer.provide(SozlukLive))` — wrong direction. Sozluk doesn't provide anything Drizzle needs.

## `ManagedRuntime` — per-request runtimes

Phoenix builds a fresh `ManagedRuntime` for each request. The runtime instantiates every layer once (cold-start cost) and reuses the constructed services for the request's duration.

```ts
// worker/graphql/runtime.ts
export namespace GraphQLRuntime {
  export const layer = (env: Env, request: Request, sessionData: SessionData) =>
    Layer.mergeAll(
      Layer.succeed(CloudflareEnv, env),
      Layer.succeed(RequestContext, {headers: request.headers, url: request.url, method: request.method}),
      Layer.succeed(Auth, {user: sessionData?.user, session: sessionData?.session}),
    );

  export const make = (env: Env, request: Request, sessionData: SessionData) =>
    ManagedRuntime.make(layer(env, request, sessionData));
}
```

Per-request lifecycle:

1. Hono's `/graphql` handler receives the request.
2. `GraphQLRuntime.make(env, request, sessionData)` builds the runtime.
3. The runtime runs the resolver Effect: `runtime.runPromise(handler)`.
4. After the response is sent, the runtime's scope finalizes (services with finalizers get cleaned up; phoenix has none).

`ManagedRuntime` is cheap to construct — it's just a closure over the layer. The per-request cost is the layer's construction effects (one `drizzle(env.PHOENIX_DB, {schema})` call), which is microseconds.

## Multiple runtimes — graphql + admin

Phoenix has two runtimes:

- **GraphQL runtime** — provides `Sozluk | Pano | Vote | Pasaport | Auth | RequestContext | CloudflareEnv | Drizzle`. Built per request to `/graphql`.
- **Admin runtime** — provides `SozlukAdmin | PanoAdmin | PasaportAdmin | AdminAuth | CloudflareEnv | Drizzle`. Built per request to `/api/admin/*`.

Separate runtimes because the surface area is genuinely different:

- Admin routes need `AdminAuth.required` (env-gated initially; future hardening lands inside the layer). Resolvers don't.
- Admin routes don't need the GraphQL `Auth` service (user session info). They have no user context.
- Admin services (`SozlukAdmin`) own different operations than resolver services (`Sozluk`). Bundling them would force every resolver to depend on admin code.

Shape: see `apps/web/worker/graphql/runtime.ts` (the `GraphQLRuntime.make` namespace) and `apps/web/worker/admin/runtime.ts` (the `AdminRuntime.make` namespace) for the canonical wiring. Both follow the same three-layer cake:

1. **Per-request values** — `Layer.succeed` for `CloudflareEnv`, `RequestContext`, and the runtime-specific auth (`Auth` for GraphQL, none for admin since `AdminAuthLive` derives from env).
2. **Drizzle** — built from `CloudflareEnv`.
3. **Feature layer** — `Layer.mergeAll` of every feature `Live`, with `provideMerge(VoteLive)` once for the `Sozluk` + `Pano` slice (both depend on `Vote`; neither depends on the other, so they merge in parallel and share the single `Vote` instance).

The final composition is `Layer.mergeAll(DataPlane, RequestValues)` after providing `RequestValues` into the data plane. This shape satisfies the `@effect/language-service` `layerMergeAllWithDependencies` check.

Why the two-step instead of stacking `Layer.provide` calls: `Layer.mergeAll(A, B)` runs `A` and `B` in parallel, so when `A` needs something `B` provides the dep won't resolve. Build the dependent slice with one explicit `Layer.provide`, then merge in the request values at the top.

Why `provideMerge` for `Vote` specifically: `Sozluk` and `Pano` both yield `Vote`, but a plain `Layer.provide(VoteLive)` would erase `Vote` from the merged layer's output type. `Layer.provideMerge(VoteLive)` provides `Vote` to consumers *and* re-exposes it at the top — useful when other layers in the same merge (or a downstream resolver) also reach for `Vote`.

Hono routes call the appropriate `make*Runtime` and `runPromise` the Effect inside.

## Running an Effect against a runtime

Three forms, pick by what you need at the call site:

```ts
// Returns Promise<A>. Throws on failure.
await runtime.runPromise(effect);

// Returns Promise<Exit<A, E>>. Never throws; you inspect Exit.
const exit = await runtime.runPromiseExit(effect);

// Returns Effect<A, E, never> (deps already satisfied). For composing into another runtime.
const ready = runtime.runtime().pipe(Effect.flatMap((rt) => Effect.provideRuntime(effect, rt)));
```

Phoenix's resolver wrapper uses `runPromiseExit` — it inspects the `Exit` to map errors to GraphQL wire codes without throwing.

## Don't construct layers per call

```ts
// ❌ wrong — builds Drizzle once per resolver call
const handler = Effect.gen(function*() {
  return yield* Effect.provide(someEffect, DrizzleLive);
});

// ✅ right — Drizzle is built once at runtime creation; resolver just uses it
const runtime = ManagedRuntime.make(DrizzleLive);
const handler = Effect.gen(function*() {
  const db = yield* Drizzle;
  // ...
});
```

`Layer.provide` *inside* an effect re-runs the layer's construction every time the effect runs. For Drizzle that's a `drizzle(...)` call per query — wasteful. Build the runtime once per request; reuse the constructed services across every effect.

## When a layer fails

`Layer.effect`'s construction can fail (e.g., env var missing, config invalid). The failure propagates to runtime construction:

```ts
const runtime = ManagedRuntime.make(SomeLayer);
const result = await runtime.runPromiseExit(handler);
// If SomeLayer fails to construct, the Exit is a failure with that layer's error.
```

Phoenix's layers have no construction failures — `DrizzleLive` just constructs the drizzle builder, no validation. If `AdminAuthLive` later validates a config, its construction could fail; that surfaces as a layer error before any resolver runs.

## See also

- [effect-context-service.md](./effect-context-service.md) — service definition
- [feature-services.md](./feature-services.md) — the layered architecture (`Drizzle → features → resolvers`)
- [effect-testing.md](./effect-testing.md) — providing test layers
- `worker/graphql/runtime.ts` — canonical phoenix runtime example
