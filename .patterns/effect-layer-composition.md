# Layer composition and runtime wiring

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

How phoenix builds Effect runtimes from layers. Read [effect-context-service.md](./effect-context-service.md) first, then [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) for *where* these layers get provided (worker scope vs per request).

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

The result is `Layer.Layer<WorkerFateServices, never, Database | BetterAuth>` — the feature graph is fully wired internally, and the only unresolved `R` is the two seams (`Database`, `BetterAuth`) provided once when the runtime is built (`index.ts`). The per-request pair (`CurrentUser`, `LivePublisher`) is provided onto each operation effect by the interpreter, not here. See [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) for the worker-scope vs request-scope split.

### Direction of `Layer.provide`

`A.pipe(Layer.provide(B))` means: **B's outputs satisfy A's inputs.** The piped form reads "A, provided with B's services." Common confusion: it's not "provide A to B."

If `Sozluk` needs `Drizzle`:
- `SozlukLive.pipe(Layer.provide(DrizzleLive))` — correct. Drizzle satisfies Sozluk's needs.
- `DrizzleLive.pipe(Layer.provide(SozlukLive))` — wrong direction. Sozluk doesn't provide anything Drizzle needs.

### `provide` vs `provideMerge`

`Layer.provide(B)` discharges `B`'s services from `A`'s `R` channel but *does not* re-expose them at the top — the output type drops them. `Layer.provideMerge(B)` does the same discharge *and* keeps `B`'s services in the output. Use `provideMerge` when something downstream of this Layer (a sibling in the same `mergeAll`, or a consumer that yields the Tag directly) needs to reach the provided service. Phoenix uses it for `Vote` (both `Sozluk` and `Pano` depend on it) and for `Drizzle` (the `/fate` route yields `Pasaport` directly over a Layer that exposes `Drizzle`, via the runtime's built context — `Layer.effectContext`).

## Parameterized Layer factories

Some Layers need values resolved at worker init — `Drizzle` over the bound D1, `Pasaport` over a resolved better-auth instance, the whole fate data plane over both. Phoenix's convention for those is **a factory function `(deps) => Layer.Layer<...>`**, not a `Context.Service<…Layer>` wrapper around the composed Layer.

The canonical examples — all in `apps/web/worker/`:

- `makeDrizzleLayer(db)` in `db/Drizzle.ts` — wraps an already-constructed drizzle instance in `Layer.succeed(Drizzle)`.
- `makePasaportLive(auth)` in `features/pasaport/Pasaport.ts` — closes a `Layer.effect(Pasaport)` body over the resolved better-auth instance.
- `makeFateLayer` in `features/fate/layers.ts` — composes `Drizzle`, the feature services, and `Pasaport` into the worker-level data plane. (This one is NOT a `(deps) => Layer` factory: it's a **zero-arg layer constant** whose `R` declares the two seams `Database | BetterAuth`, discharged once when the runtime is built — see the note below.)
- `makeAppLive(opts)` in `http/app.ts` — the top-level router Layer over its sub-layers (fate, live, better-auth).

This shape has ecosystem precedent: `@effect/sql-d1` exposes its driver as `layer(config)` (a function returning a Layer), and `@alchemy.run/better-auth`'s `AuthProviderLayer<Config>()(name, body)` is a factory that returns a Layer parameterized over the provider's config.

### Why a factory, not a `Context.Service` wrapper

The temptation is to define `class FateLayer extends Context.Service<FateLayer, Layer.Layer<…>>(…)` and yield it. Don't. A plain Layer value (either a `(deps) => Layer` factory or a zero-arg layer constant that declares its seams in `R`) is the right one here for three reasons:

- **The signature is the proof.** `makePasaportLive(auth): Layer.Layer<Pasaport, never, never>` says, at the type level, that the resolved `auth` was discharged at the factory call (no `RuntimeContext` leaks downstream); `makeFateLayer: Layer.Layer<WorkerFateServices, never, Database | BetterAuth>` says exactly which seams remain — both unresolved deps are right there in the type. Wrapping either in a `Context.Service` adds a yield site between caller and Layer and obscures that proof.
- **No construction effect, no async, no scoped resource.** A `Context.Service<…Layer>` wrapper buys nothing the plain Layer doesn't already give you: there is no `Effect.gen` to host (the composition is pure), no scoped acquire/release (the Layers themselves own their lifecycle). It's ceremony around a Layer value.
- **Dep visibility is a feature.** The two or three sites that wire the Layer — `worker/index.ts`, the integration test harness — are exactly where the wiring should be visible. `makeFateLayer`'s `Database | BetterAuth` requirement is a compile error at whatever provides those seams (the runtime build in `index.ts`), which is the correct blast radius. A `Context.Service` wrapper would absorb that into a layer file and hide it from every call site that just yields the tag.

### When a `Context.Service` Layer *does* earn its place

The factory shape is for **pure composition over already-resolved values**. A `Context.Service` Layer (with `Layer.effect(...)`) is the right call when the Layer is genuinely doing scoped work:

- **Async or fallible construction** — building the service requires a `yield*` of an effect that can fail (e.g. `BetterAuthLive` resolving `Random` + `Cloudflare.D1.QueryDatabase`).
- **Scoped resources** — a service that needs `Layer.scoped` for finalizers (connection pools, file handles).
- **A real domain shape** — the service has methods (`Pasaport.validateSession`, `Drizzle.run`), not just a composed Layer.

The single rule: **if the construction is `Layer.merge` / `Layer.provide` over plain values, write a factory.** If it's `Layer.effect`/`Layer.scoped` over an Effect, write a `Context.Service` and `Layer.effect(Tag)(...)` it.

### Related idioms — single-discharge wiring

Two related patterns thread the same needle (resolve once, hand the plain value forward):

- **The BetterAuth RuntimeContext-escape** ([better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md)) — `betterAuth.auth` is `Effect.Effect<Auth, never, RuntimeContext>`; yielding it inside a feature service would propagate `RuntimeContext` onto every method's `R` and infect every resolver. Instead, yield once in worker init and thread the resolved `auth` as a plain value into `makePasaportLive(auth)`. Same shape as the factory pattern above, applied to a single service rather than a composed Layer.
- **Per-call sibling DO resolution** ([ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)) — co-hosted Durable Objects that reference each other can't satisfy each other's Layer requirements (cycle), so the sibling Tag is resolved per-call inside RPC methods and discharged at the seam with the worker's captured context. The Layer's init phase stays cycle-free.

Both follow the same idiom: pay the discharge cost once, at a known seam, and downstream consumers see a plain value (or a Layer with `R = never`).

## One worker-level `ManagedRuntime`, built from the worker layer set — init-only

Phoenix's old design built a fresh `ManagedRuntime` per `/fate` request; a brief correction (ADR 0029) removed it entirely, capturing a `Context` and running each resolver on the *default* runtime. Both are gone. Now there is exactly ONE worker-level `ManagedRuntime` (ADR 0041, supersedes 0029) and since the v2 cutover (ADR 0043) it is **init-only wiring**: the worker's init phase builds `Drizzle` + the feature services once as the worker layer set, folds them into that one runtime as the layer-build/memoization vehicle, and the built context reaches the routes as a dependency-free context layer. Nothing runs through the runtime per request — the `/fate` route yields the native interpreter on the request fiber, and `CurrentUser` + `LivePublisher` are provided onto each operation per request as values off the request context, not baked into the runtime. See [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) for the full picture.

## The worker layer set

The worker builds one Layer set and folds it into the one worker-level `ManagedRuntime`:

- **Worker layer set** — `Drizzle` + feature services (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`), the `WorkerFateServices`. Built by the zero-arg `makeFateLayer` in `worker/features/fate/layers.ts` (its `R` is the two seams `Database | BetterAuth`, resolved once in init). The two genuinely per-request services (`CurrentUser`, `LivePublisher`) are not in this Layer — the interpreter provides them onto each operation at run time, as values off the request context.

Built once from the `Database` seam in worker init, `Drizzle` is shared by every feature service. The per-request `CurrentUser`/`LivePublisher` are the only services layered on top, and they go on inside the interpreter per operation, not in this Layer.

Why two-step (build feature slice first, then fold into the runtime) instead of stacking `Layer.provide` calls inline: `Layer.mergeAll(A, B)` runs `A` and `B` in parallel, so when `A` needs something `B` provides the dep won't resolve. Build the dependent slice with `Layer.provide`/`provideMerge`, then the interpreter merges in the per-request values with `Effect.provideService` onto each operation effect.

Why `provideMerge` for `Vote` specifically: `Sozluk` and `Pano` both yield `Vote`, but a plain `Layer.provide(VoteLive)` would erase `Vote` from the merged layer's output type. `Layer.provideMerge(VoteLive)` provides `Vote` to consumers *and* re-exposes it at the top — useful when other layers in the same merge (or a downstream resolver) also reach for `Vote`.

## Running an Effect

Worker code never calls `runPromise*` on the request path. Since the v2 cutover (ADR 0043) the whole serving path is one Effect: the `/fate` route yields `FateInterpreter.handleRequest` on the request fiber, the interpreter provides the per-request pair onto each operation (`Effect.provideService(CurrentUser, ...)` / `(LivePublisher, ...)`), and the single Effect→Promise boundary is the **platform bridge** (alchemy's worker bridge running the compiled `HttpRouter.toHttpEffect`). The package's one `runtime.runPromise` survives in `packages/fate-effect/src/Executor.ts`, oracle-baseline-only ([fate-effect-compiler.md](./fate-effect-compiler.md)). Handler and source bodies are `Effect.fn` generators that `yield*` services; they never call `runPromise*` themselves.

The interpreter inspects each operation's `Exit` and maps tagged errors onto fate wire codes via their `FateWireCode` annotations ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)). The HTTP edge (`HttpRouter.toHttpEffect`) compiles the router Layer into the worker's `fetch` and handles `Exit` for typed-JSON groups itself ([alchemy-http-router.md](./alchemy-http-router.md)).

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

Phoenix's feature Layers don't fail at construction today — `DrizzleLive` just wraps a constructed builder, no validation. `BetterAuthLive` can fail at the `Random`/`Cloudflare.D1.QueryDatabase` resolve step; that surfaces as a Layer error at the worker's outer `Effect.provide`, before any handler runs.

## See also

- [effect-context-service.md](./effect-context-service.md) — service definition
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — the one init-only worker-level `ManagedRuntime` the worker layer set is folded into; worker-scope vs per-request split
- [feature-services.md](./feature-services.md) — the layered architecture (`Drizzle → features → resolvers`)
- [effect-testing.md](./effect-testing.md) — providing test layers
- `worker/features/fate/layers.ts` — canonical phoenix Layer composition (`makeFateLayer`)
