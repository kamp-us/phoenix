# Worker HTTP transport layout

`worker/http/` is the transport surface — app composition + the one typed-JSON
route phoenix exposes. It is **not** a feature: features are app-level groupings
(ADR 0036); transport is the substrate features are mounted on. The folder stays
a thin composition layer that pulls each feature's route into one router.

Read this with
[alchemy-http-router.md](./alchemy-http-router.md) (the `HttpRouter` /
`HttpApiBuilder` mechanics this layout uses).

## The shape

```
worker/http/
├── app.ts        # `makeAppLive(options)` — composes the AppLive layer
├── app.test.ts   # end-to-end tests against the composed router
└── health.ts     # the lone HttpApiBuilder group: GET /api/health
```

That is the whole folder. The old `/api/admin/*` seeder surface
(`admin-api.ts`, `admin-handlers.ts`, `admin-auth.ts`, the
`SozlukAdmin`/`PanoAdmin`/`PasaportAdmin` services, the `adminAllowed`
(`ENVIRONMENT === "development"`) gate) was deleted (ADR 0012 superseded):
gating destructive ops behind a single mutable `ENVIRONMENT` string is
fail-open, and the seeders were throwaway data-population. The only
`HttpApiBuilder` group that remains is the liveness probe.

`worker/index.ts` is the only consumer: it calls `makeAppLive({...})` with the
worker-init-resolved layers (`fateLayer`, `liveLayer`, `betterAuthLayer`) and
compiles the result with `HttpRouter.toHttpEffect(AppLive)` for `fetch`.

## Two kinds of route

`makeAppLive` splits its inputs into the two route shapes the worker serves
([alchemy-http-router.md](./alchemy-http-router.md)):

- **Typed JSON** — `healthApiLayer` (`health.ts`), an `HttpApiBuilder` group
  with a schema-encoded response (`GET /api/health` → `{status, environment}`).
  Its `WorkerEnvironment` requirement is satisfied at worker scope (alchemy
  provides it), so the layer carries no per-request markers to discharge here.
- **Raw `Request`** — the `fateRoute` / `authRoute` / `liveRoute` layers
  (`POST /fate`, `* /api/auth/*`, `* /fate/live`), imperative `HttpRouter.add`
  routes reading `Cloudflare.Request`. Merged, then piped through
  `HttpRouter.provideRequest` over `fateLayer` + `liveLayer` +
  `betterAuthLayer`.

The two groups merge into `AppLive`:

```ts
// worker/http/app.ts (abridged)
export const makeAppLive = (options: {
  readonly fateLayer: Layer.Layer<WorkerFateServices>;
  readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
  readonly betterAuthLayer: Layer.Layer<BetterAuth.BetterAuth, never, any>;
}) => {
  const typedJson = healthApiLayer;
  const rawRoutes = Layer.mergeAll(fateRoute, authRoute, liveRoute).pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(options.fateLayer, options.liveLayer).pipe(
        Layer.merge(options.betterAuthLayer),
      ),
    ),
  );
  return Layer.mergeAll(typedJson, rawRoutes);
};
```

The reason `provideRequest` is used instead of `Layer.provide` is that
`HttpRouter.add` lifts handler `R`s onto route-requirement markers that plain
`Layer.provide` doesn't discharge — see the comments in `app.ts` and
[alchemy-http-router.md](./alchemy-http-router.md). `betterAuthLayer` is merged
with `Layer.merge` (not folded into the flat `mergeAll`) because its `R` is left
unconstrained (`any`) for the outer worker `Effect.provide` to discharge.

## Why it's distinct from `features/`

`http/` is **not a feature**. It's app composition — the router root that mounts
the per-feature routes. Each feature owns its own route module
(`features/fate/route.ts`, `features/fate-live/route.ts`,
`features/pasaport/route.ts`); `http/app.ts` only merges them and discharges
their requirements. The folder name reflects the layer (transport) it occupies,
not a domain it owns.

`http/` and `features/` are siblings of the same `worker/` root for the same
reason `db/` is: they're substrate, not product (ADR 0036). Moving `http/` under
`features/http/` would be a category error — it's the shell every feature route
runs inside, not a slice of product/framework code.

## The health probe reads env at worker scope

`health.ts`'s handler reads the deploy environment off
`Cloudflare.WorkerEnvironment` (alchemy provides it at worker scope), casting the
untyped record at the read site — the [worker-environment-pattern.md](./worker-environment-pattern.md)
shape. `WorkerEnvironment` surfaces as a route marker discharged at the app
boundary with `provideRequest`, satisfied at worker scope. `healthApiLayer` also
provides the platform stubs `HttpApiBuilder.layer` needs (`HttpPlatform`,
`FileSystem`, `Path`, `Etag`) — Workers serve no files, so the file-serving paths
die if ever hit; the typed-JSON endpoint never produces a file response, so the
stubs are safe.

## Adding an HTTP route

- **A new feature route** (raw `Request` / SSE) lives **with its feature**
  (`features/<feature>/route.ts`), exposed as an `HttpRouter.add` layer. Add it
  to the `Layer.mergeAll(fateRoute, authRoute, liveRoute)` list in `app.ts` and,
  if it has worker-level requirements, make sure they're in the
  `provideRequest` layer set.
- **A new typed-JSON endpoint** extends an `HttpApiBuilder` group — `health.ts`
  is the live example of the group shape (declare the endpoint on an
  `HttpApiGroup`, implement it with `HttpApiBuilder.group`, wire it through
  `HttpApiBuilder.layer` with the platform stubs). For a payload-bearing
  endpoint, declare the `payload` Schema on the `HttpApiEndpoint` so
  `HttpApiBuilder` decodes the body before the handler runs (see
  [effect-schema-validation.md](./effect-schema-validation.md)).

## See also

- [alchemy-http-router.md](./alchemy-http-router.md) — the `HttpRouter` /
  `HttpApiBuilder` primitives this folder uses; route markers vs Layer
  requirements; `provideRequest` semantics.
- [worker-environment-pattern.md](./worker-environment-pattern.md) — how the
  health probe reads `ENVIRONMENT`.
- [ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md) — why
  this lives under `http/` and not `features/http/`.
- [ADR 0027](../.decisions/0027-http-router-drop-hono.md) — the
  HttpRouter+HttpApi adoption this layout assumes.
