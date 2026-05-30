# Layer composition and runtime wiring

How phoenix builds Effect runtimes from layers. Read [effect-context-service.md](./effect-context-service.md) first, then [alchemy-runtime.md](./alchemy-runtime.md) for *where* these layers get provided (worker scope vs per request).

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

The phoenix feature-layer composition uses both. From `worker/features/fate/layers.ts`:

```ts
const SozlukPanoLayer = Layer.mergeAll(SozlukLive, PanoLive).pipe(
  Layer.provideMerge(VoteLive),
);
const FeatureLayer = Layer.mergeAll(PasaportLive, SozlukPanoLayer, StatsLive);

return FeatureLayer.pipe(Layer.provideMerge(DrizzleLayer));
```

Read this inside-out:

1. `Sozluk` and `Pano` both depend on `Vote` (and neither depends on the other) — they merge in parallel and `provideMerge(VoteLive)` once so the merged slice carries `Vote` at the top.
2. `Pasaport` + `Stats` only need `Drizzle`, so they merge alongside the Sozluk/Pano slice.
3. `Drizzle` is the bottom — `provideMerge(DrizzleLayer)` feeds it to every consumer above *and* re-exposes it at the top, so a downstream `yield* Drizzle` works.

The result is `Layer.Layer<WorkerFateServices>` — `R` is `never`, every dep is satisfied. Per-request services (`Auth`, `HttpServerRequest`) layer on top inside the `/fate` route, not here. See [alchemy-runtime.md](./alchemy-runtime.md) for the worker-scope vs request-scope split.

### Direction of `Layer.provide`

`A.pipe(Layer.provide(B))` means: **B's outputs satisfy A's inputs.** The piped form reads "A, provided with B's services." Common confusion: it's not "provide A to B."

If `Sozluk` needs `Drizzle`:
- `SozlukLive.pipe(Layer.provide(DrizzleLive))` — correct. Drizzle satisfies Sozluk's needs.
- `DrizzleLive.pipe(Layer.provide(SozlukLive))` — wrong direction. Sozluk doesn't provide anything Drizzle needs.

### `provide` vs `provideMerge`

`Layer.provide(B)` discharges `B`'s services from `A`'s `R` channel but *does not* re-expose them at the top — the output type drops them. `Layer.provideMerge(B)` does the same discharge *and* keeps `B`'s services in the output. Use `provideMerge` when something downstream of this Layer (a sibling in the same `mergeAll`, or a consumer that yields the Tag directly) needs to reach the provided service. Phoenix uses it for `Vote` (both `Sozluk` and `Pano` depend on it) and for `Drizzle` (the per-request `/fate` route still needs to provide `Auth` over a Layer that exposes `Drizzle`).

## Parameterized Layer factories

Some Layers need values resolved at worker init — `Drizzle` over the bound D1, `Pasaport` over a resolved better-auth instance, the whole fate data plane over both. Phoenix's convention for those is **a factory function `(deps) => Layer.Layer<...>`**, not a `Context.Service<…Layer>` wrapper around the composed Layer.

The canonical examples — all in `apps/web/worker/`:

- `makeDrizzleLayer(db)` in `db/Drizzle.ts` — wraps an already-constructed drizzle instance in `Layer.succeed(Drizzle)`.
- `makePasaportLive(auth)` in `features/pasaport/Pasaport.ts` — closes a `Layer.effect(Pasaport)` body over the resolved better-auth instance.
- `makeFateLayer(db, auth)` in `features/fate/layers.ts` — composes `Drizzle`, the feature services, and `Pasaport` into the worker-level data plane.
- `makeAdminLayer(db)` in `features/fate/layers.ts` — the parallel admin layer set (ADR 0012).
- `makeAppLive(opts)` in `http/app.ts` — the top-level router Layer over its sub-layers (fate, admin, live, better-auth).

This shape has ecosystem precedent: `@effect/sql-d1` exposes its driver as `layer(config)` (a function returning a Layer), and `@alchemy.run/better-auth`'s `AuthProviderLayer<Config>()(name, body)` is a factory that returns a Layer parameterized over the provider's config.

### Why a factory, not a `Context.Service` wrapper

The temptation is to define `class FateLayer extends Context.Service<FateLayer, Layer.Layer<…>>(…)` and yield it. Don't. The factory shape is the right one here for three reasons:

- **The signature is the proof.** `makeFateLayer(db, auth): Layer.Layer<WorkerFateServices, never, never>` says, at the type level, that no `RuntimeContext` (or any other upstream service) leaks downstream — the Layer's `R` is `never` because every dep was resolved at the factory call. Wrapping it in a `Context.Service` adds a yield site between caller and Layer and obscures that proof.
- **No construction effect, no async, no scoped resource.** A `Context.Service<…Layer>` wrapper buys nothing the factory doesn't already give you: there is no `Effect.gen` to host (the composition is pure), no scoped acquire/release (the Layers themselves own their lifecycle), and no async init (deps are already resolved). It's ceremony around a function call.
- **Dep visibility is a feature.** The two or three call sites that wire the Layer — `worker/index.ts`, the integration test harness — are exactly where the wiring should be visible. A signature change (`makeFateLayer(db)` → `makeFateLayer(db, auth)`) is a compile error at the call site, which is the correct blast radius. A `Context.Service` wrapper would absorb that into a layer file and hide it from every call site that just yields the tag.

### When a `Context.Service` Layer *does* earn its place

The factory shape is for **pure composition over already-resolved values**. A `Context.Service` Layer (with `Layer.effect(...)`) is the right call when the Layer is genuinely doing scoped work:

- **Async or fallible construction** — building the service requires a `yield*` of an effect that can fail (e.g. `BetterAuthLive` resolving `Random` + `D1Connection`).
- **Scoped resources** — a service that needs `Layer.scoped` for finalizers (connection pools, file handles).
- **A real domain shape** — the service has methods (`Pasaport.validateSession`, `Drizzle.run`), not just a composed Layer.

The single rule: **if the construction is `Layer.merge` / `Layer.provide` over plain values, write a factory.** If it's `Layer.effect`/`Layer.scoped` over an Effect, write a `Context.Service` and `Layer.effect(Tag)(...)` it.

### Related idioms — single-discharge wiring

Two related patterns thread the same needle (resolve once, hand the plain value forward):

- **The BetterAuth RuntimeContext-escape** ([better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md)) — `betterAuth.auth` is `Effect.Effect<Auth, never, RuntimeContext>`; yielding it inside a feature service would propagate `RuntimeContext` onto every method's `R` and infect every resolver. Instead, yield once in worker init and thread the resolved `auth` as a plain value into `makePasaportLive(auth)`. Same shape as the factory pattern above, applied to a single service rather than a composed Layer.
- **Per-call sibling DO resolution** ([ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)) — co-hosted Durable Objects that reference each other can't satisfy each other's Layer requirements (cycle), so the sibling Tag is resolved per-call inside RPC methods and discharged at the seam with the worker's captured context. The Layer's init phase stays cycle-free.

Both follow the same idiom: pay the discharge cost once, at a known seam, and downstream consumers see a plain value (or a Layer with `R = never`).

## No per-request `ManagedRuntime`

Phoenix's old design built a fresh `ManagedRuntime` per `/fate` request. That's gone (ADR 0029). The worker's init phase builds `Drizzle` + the feature services once and provides them as worker-level Layers; the `/fate` route provides `Auth` per request and picks up the upstream `HttpServerRequest` Tag from `alchemy/HttpRouter`. fate's bridge runs each resolver with `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` over the captured `Context<FateEnv>` — no per-request runtime, nothing to dispose. See [alchemy-runtime.md](./alchemy-runtime.md) for the full picture.

## The worker layer set

> **Update:** the admin layer set (`makeAdminLayer`, `SozlukAdmin`/`PanoAdmin`/
> `PasaportAdmin`, `AdminAuth`, the `/api/admin/*` groups) described here was
> deleted (fail-open `ENVIRONMENT` gate; throwaway seeders). Only the request layer
> set below remains; there is no longer a request/admin split.

The worker builds one Layer set, not a per-request `ManagedRuntime`:

- **Request layer set** — `Drizzle` + feature services (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`). Built by `makeFateLayer(db, auth)` in `worker/features/fate/layers.ts`. The `/fate` route provides `Auth` per request; `HttpServerRequest` comes from the upstream `effect/unstable/http/HttpServerRequest` Tag the alchemy/HttpRouter runtime already provides.

Why the parallel-but-separate shape:

- Admin routes need `AdminAuth.required` (env-gated initially; future hardening lands inside `AdminAuthLive`). Resolvers don't.
- Admin routes don't need the request-layer `Auth` (user session info). They have no user context — `AdminAuth` is a single boolean today.
- Admin services (`SozlukAdmin`) own different operations than resolver services (`Sozluk`). Bundling them would force every resolver to depend on admin code.

Both sit on the same `Drizzle` instance, built once from the bound D1 in worker init.

Why two-step (build feature slice first, merge in request values at top) instead of stacking `Layer.provide` calls: `Layer.mergeAll(A, B)` runs `A` and `B` in parallel, so when `A` needs something `B` provides the dep won't resolve. Build the dependent slice with `Layer.provide`/`provideMerge`, then merge in the request-level values at the top with `Effect.provideService` inside the route.

Why `provideMerge` for `Vote` specifically: `Sozluk` and `Pano` both yield `Vote`, but a plain `Layer.provide(VoteLive)` would erase `Vote` from the merged layer's output type. `Layer.provideMerge(VoteLive)` provides `Vote` to consumers *and* re-exposes it at the top — useful when other layers in the same merge (or a downstream resolver) also reach for `Vote`.

## Running an Effect

In the old per-request-runtime world there were three forms (`runPromise`, `runPromiseExit`, `runtime`). On alchemy the only one that matters at the seam is `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` — and **that lives inside the fate bridge**, exactly once (`worker/features/fate/effect.ts`). Resolver and source bodies are Effect generators that `yield*` services; they never call `runPromise*` themselves.

The bridge inspects the `Exit` and maps tagged errors onto fate wire codes ([fate-effect-bridge.md](./fate-effect-bridge.md)). The HTTP edge (`HttpRouter.toHttpEffect`) compiles the router Layer into the worker's `fetch` and handles `Exit` for typed-JSON groups itself ([alchemy-http-router.md](./alchemy-http-router.md)).

## Don't construct layers per call

```ts
// ❌ wrong — builds Drizzle once per resolver call
const handler = Effect.gen(function*() {
  return yield* Effect.provide(someEffect, DrizzleLive);
});

// ✅ right — Drizzle is built once at worker init; resolver just uses it
const handler = Effect.gen(function*() {
  const {run, batch} = yield* Drizzle;
  // ...
});
```

`Layer.provide` *inside* an effect re-runs the layer's construction every time the effect runs. For Drizzle that's a `drizzle(...)` call per query — wasteful. Build the worker-level Layers in init; reuse the constructed services across every request.

## When a layer fails

`Layer.effect`'s construction can fail (e.g., env var missing, config invalid). The failure propagates to the Effect that pulls the Layer in:

```ts
const result = await Effect.runPromiseExit(
  someEffect.pipe(Effect.provide(SomeLayer)),
);
// If SomeLayer fails to construct, the Exit is a failure with that layer's error.
```

Phoenix's feature Layers don't fail at construction today — `DrizzleLive` just wraps a constructed builder, no validation. `BetterAuthLive` can fail at the `Random`/`D1Connection` resolve step; that surfaces as a Layer error at the worker's outer `Effect.provide`, before any handler runs.

## See also

- [effect-context-service.md](./effect-context-service.md) — service definition
- [alchemy-runtime.md](./alchemy-runtime.md) — where worker-scope vs per-request Layers get provided; the captured `Context<FateEnv>`
- [feature-services.md](./feature-services.md) — the layered architecture (`Drizzle → features → resolvers`)
- [effect-testing.md](./effect-testing.md) — providing test layers
- `worker/features/fate/layers.ts` — canonical phoenix Layer composition (`makeFateLayer`, `makeAdminLayer`)
