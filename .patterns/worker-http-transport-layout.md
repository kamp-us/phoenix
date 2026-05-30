# Worker HTTP transport layout

`worker/http/` is the transport surface — app composition, typed-JSON admin
API spec, admin handlers, admin auth gate. It is **not** a feature: features
are app-level groupings (ADR 0036); transport is the substrate features are
mounted on. The handlers route to per-feature `*Admin` services that live
**with their feature**, so the http folder stays a thin composition layer
over the domain.

Read this with
[alchemy-http-router.md](./alchemy-http-router.md) (the `HttpRouter` /
`HttpApiBuilder` mechanics this layout uses) and
[feature-services.md](./feature-services.md) (where the `*Admin` services
live).

## The shape

```
worker/http/
├── app.ts             # `makeAppLive(options)` — composes the AppLive layer
├── app.test.ts        # end-to-end tests against the composed router
├── admin-api.ts       # typed HttpApi spec for `/api/admin/*` + `/api/health`
├── admin-handlers.ts  # HttpApiBuilder group handlers delegating to *Admin
├── admin-auth.ts      # `AdminAuth` Tag + `adminAllowed` predicate
└── admin-auth.test.ts # the predicate's truth table
```

`worker/index.ts` is the only consumer: it calls `makeAppLive({...})` with the
worker-init-resolved layers (`fateLayer`, `adminLayer`, `liveLayer`,
`betterAuthLayer`) and compiles the result with
`HttpRouter.toHttpEffect(AppLive)` for `fetch`.

## Why it's distinct from `features/`

Admin transport is **not a feature**. It routes to features that own `*Admin`
services. The folder name reflects the layer (transport) it occupies, not a
domain it owns.

The split is:

- **`worker/http/` — transport surface.** Owns the `HttpApi` spec, the group
  handlers that decode payloads + delegate, and the env-gated `AdminAuth`.
  Knows about every admin-bearing feature; depends on each of their `*Admin`
  services.
- **`worker/features/<feature>/<Feature>Admin.ts` — feature-owned admin
  domain.** Each `*Admin` service is its own
  `Context.Service<...>()("@phoenix/<feature>/<Feature>Admin")` — same shape
  as the feature's main service, gated by `AdminAuth.required` at the
  transport edge. ADR 0012 (admin parallel services) is the rationale.

The handler delegates one call deep:

```ts
// worker/http/admin-handlers.ts (abridged)
const sozlukGroup = HttpApiBuilder.group(AppApi, "sozluk", (h) =>
  h.handle("upsertTerm", ({payload}) =>
    Effect.gen(function* () {
      yield* requireAdmin;                    // env gate (admin-auth.ts)
      const admin = yield* SozlukAdmin;       // service from features/sozluk/
      const result = yield* admin.seedTerm({...payload});
      return new UpsertTermResult({...result});
    }).pipe(Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)),
  ),
);
```

The handler does the transport job (decode payload, gate, encode response,
map infra failure → 500). The `*Admin` service does the domain job (write the
rows, refresh aggregates). Reversing the split — putting `seedTerm`'s SQL in
the handler, or putting the `HttpApi` spec under `features/sozluk/` — collapses
two distinct layers into one and breaks ADR 0036's "features = app-level
named groupings" rule.

## What goes where

A new admin endpoint touches both layers:

1. **In the feature** (`features/<feature>/<Feature>Admin.ts`): add the
   method. Same shape as `Sozluk`/`Pano` — one `Context.Service`, methods
   are `Effect.fn("<Feature>Admin.method")(function*(...))` over the
   destructured `Drizzle`.
2. **In `worker/http/admin-api.ts`**: add the endpoint to the feature's
   `HttpApiGroup` — `payload` schema, `success` schema, `error: ForbiddenError`.
3. **In `worker/http/admin-handlers.ts`**: add the `h.handle(...)` body —
   `yield* requireAdmin`, then `yield* (yield* <Feature>Admin).method(...)`,
   then return the success class.
4. **In `worker/features/fate/layers.ts`** (if it's a new `*Admin` service
   altogether): add it to `WorkerAdminServices` and `makeAdminLayer`.

Nothing else touches the SPA, the fate layer, or the route table — admin is
self-contained behind `AdminAuth.required` + the env predicate.

## The env gate

`admin-auth.ts` exposes two pieces:

- **`adminAllowed(env)` — pure predicate.** `env.ENVIRONMENT === "development"`
  is the only truth. Pure over `{readonly ENVIRONMENT: string}` so the rule
  is testable without booting alchemy.
- **`AdminAuth` — Tag carrying `{allowed: boolean}`.** `AdminAuth.required`
  is a static `Effect` that fails with `AdminForbidden` when `allowed`
  is `false`. The handler `requireAdmin` const maps `AdminForbidden` to the
  wire `Forbidden` (403) so the typed API surfaces the gate as a real
  status.

`worker/index.ts` builds the value layer once per request with
`adminAuthLayer(adminAllowed(env))`, and `app.ts` provides it via
`HttpRouter.provideRequest` alongside the admin services. Future hardening
(karma threshold, signed admin tokens) lands inside `admin-auth.ts` with no
call-site changes — handlers keep saying `yield* AdminAuth.required`.

## Why this folder, not `features/admin/`

The bar for "feature" is ADR 0036's: a coherent app-level grouping with a
name. `admin` is not an app-level grouping — every admin operation belongs
to a product domain (seed sozluk, seed pano, backfill pasaport profiles).
Putting all of them under `features/admin/` would either (a) duplicate
domain logic away from its feature, or (b) make `features/admin/` a barrel
over the per-feature `*Admin` services — which is exactly the transport-layer
job `http/admin-handlers.ts` already does.

The right cut is the one in place: per-feature domain (`*Admin` lives with its
feature) + per-transport composition (`http/` composes them through a typed
API). `http/` and `features/` are siblings of the same `worker/` root for the
same reason `db/` is: they're substrate, not product (ADR 0036).

## The `app.ts` composition

`makeAppLive` is one function that returns one `Layer.Layer` — the input is
the worker-init-resolved layers, the output is what `HttpRouter.toHttpEffect`
turns into a `fetch`. It splits its inputs into two groups:

- **Typed JSON** — `adminApiLayer` (health + admin seeders) piped through
  `HttpRouter.provideRequest(Layer.mergeAll(adminLayer, adminAuthLayer(...)))`.
- **Raw `Request`** — the `fateRoute` / `authRoute` / `liveRoute` layers
  merged, then piped through `provideRequest` over `fateLayer + liveLayer +
  betterAuthLayer`.

The two groups merge into `AppLive`. The reason `provideRequest` is used
instead of `Layer.provide` is that `HttpRouter.add` lifts handler `R`s onto
route-requirement markers that plain `Layer.provide` doesn't discharge — see
the comments in `app.ts` and [alchemy-http-router.md](./alchemy-http-router.md).

## See also

- [alchemy-http-router.md](./alchemy-http-router.md) — the `HttpRouter` /
  `HttpApiBuilder` primitives this folder uses; route markers vs Layer
  requirements; `provideRequest` semantics.
- [feature-services.md](./feature-services.md) — the `*Admin` service shape
  the handlers delegate into.
- [ADR 0012](../.decisions/0012-admin-parallel-services.md) — admin parallel
  services + two-layer-set rationale.
- [ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md) — why
  this lives under `http/` and not `features/admin/`.
- [ADR 0027](../.decisions/0027-http-router-drop-hono.md) — the
  HttpRouter+HttpApi adoption this layout assumes.
