# HTTP routing

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

How requests are routed without Hono. The short answer: the worker's `fetch` is an `HttpRouter` compiled with `HttpRouter.toHttpEffect`. The typed JSON endpoint (`GET /api/health`) is an `HttpApiBuilder` group; raw-`Request` and SSE endpoints (`/fate`, `/api/auth/*`, `/fate/live`, …) are imperative `HttpRouter.add` routes that reach the raw request via `Cloudflare.Request` and return `HttpServerResponse.fromWeb`. All raw routes live in one manifest (`worker/http/worker-routes.ts`) that also derives the `runWorkerFirst` globs, so a route and its SPA-shadow glob can't drift.

Everything here is `@effect/platform` (`effect/unstable/http`), the model alchemy's worker already speaks — so routes drop straight into `fetch` with no adapter.

## The shape of `fetch`

The worker returns `{fetch}`. alchemy's slot accepts an `HttpEffect` — `Effect<HttpServerResponse, HttpServerError | HttpBodyError, HttpServerRequest | Scope | …>` — **or an Effect that yields one** (`alchemy@2.0.0-beta.59 — src/Http.ts` and `src/Cloudflare/Workers/HttpServer.ts`, `makeRequestEffect`'s `HttpEffect<Req> | Effect<HttpEffect<Req>>`). `HttpRouter.toHttpEffect(layer)` produces exactly the latter from a layer of routes:

```ts
return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

`AppLive` is a single `Layer` that registers every route — built by `makeAppLive` (`worker/http/app.ts`) from two sources, `HttpApiBuilder` groups and imperative `HttpRouter.add` routes, merged together. (In the deployed worker the compiled effect is additionally wrapped for Sentry when a DSN is bound — that seam lives in `worker/index.ts`, ADR 0118, and doesn't change the router shape.)

## Typed JSON: `HttpApiBuilder` groups

For endpoints with a real request/response schema — phoenix's lone case is `GET /api/health` — define an `HttpApi` spec and implement it as a group. This gives schema-decoded params/bodies and typed responses for free.

```ts
// worker/http/health.ts
// success / payload / error are passed in the endpoint's options object —
// there is no `.setPayload(...)` builder. Responses are `Schema.Class`,
// payloads are `Schema.Struct`, errors are `Schema.TaggedErrorClass`.
export class HealthStatus extends Schema.Class<HealthStatus>("@kampus/HealthStatus")({
  status: Schema.String,
  environment: Schema.NullOr(Schema.String),
  flagshipReachable: Schema.Boolean,
}) {}

const health = HttpApiEndpoint.get("health", "/api/health", {
  success: HealthStatus,
  error: HealthDegraded,   // typed 503 — see below
});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}
export class HealthApi extends HttpApi.make("phoenix").add(HealthGroup) {}
```

`HttpApi.make(id)` and `HttpApiGroup.make(name)` return values with a variadic `.add(...)`; the `class … extends` form is the convention for naming them (it's what `HttpApiBuilder.group(HealthApi, "health", …)` references by name).

A typed **error** is a `Schema.TaggedErrorClass` annotated with `httpApiStatus` — phoenix's `HealthDegraded` carries `{httpApiStatus: 503}` so the degraded-readiness body encodes as a 503 rather than the unannotated-error default of 500 (ADR 0156). A payload-bearing endpoint adds a `payload` Schema to its options; `HttpApiBuilder` decodes the request body against it before the handler runs, so `{payload}` arrives already typed (see [effect-schema-validation.md](./effect-schema-validation.md)).

The group is itself a `Layer`. `healthApiLayer` (`health.ts`) wires it:

```ts
export const healthApiLayer = HttpApiBuilder.layer(HealthApi).pipe(
  Layer.provide(healthGroup),
  Layer.provide(platformStubs),
);
```

> **Workers have no `FileSystem`, so stub `HttpPlatform`.** `HttpApiBuilder.layer` pulls in `HttpPlatform` for file responses, which the Workers runtime can't satisfy. Provide the stub set — `Etag.layer`, an `HttpPlatform` whose file methods `Effect.die`, `Path.layer`, `FileSystem.layerNoop({})` — or the layer won't build (`platformStubs` in `health.ts`). phoenix never serves files from the worker (the SPA comes from the `assets` binding), so the stub is always safe.

## Raw `Request` + SSE: imperative `HttpRouter.add`

fate's `handleRequest`, better-auth's handler, and the live SSE route all want the **raw** `Request`/`Response`, not a schema. Register them imperatively. The raw request is available as the `Cloudflare.Request` service (`src/Cloudflare/Workers/Request.ts` — a `Context.Service` over the web `Request`); hand its result back with `HttpServerResponse.fromWeb`:

```ts
// e.g. worker/features/pasaport/route.ts
export const authRoute = HttpRouter.add("*", "/api/auth/*", Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;
  const res = yield* Pasaport.handleAuth(raw);   // returns a web Response
  return HttpServerResponse.fromWeb(res);
}));
```

`HttpRouter.add(method, path, handler)` takes `"*"` for all methods, supports `:param` and `*` wildcards in the path, and accepts either an `Effect<HttpServerResponse, …>` or a `(request) => Effect<…>`. It returns a `Layer`, so it merges with the rest.

### One manifest for routes AND `runWorkerFirst`

Each raw route lives in its feature (`features/fate/route.ts`, `features/fate-live/route.ts`, `features/pasaport/route.ts`, …) and is registered in **one place**: `rawWorkerRoutes` in `worker/http/worker-routes.ts`, which pairs every route layer with the `runWorkerFirst` glob that must shadow the SPA for it. `app.ts` merges the `.route`s; `index.ts` passes the deduplicated `.glob`s to `assets.runWorkerFirst`; a lockstep unit test pins that every mount path is glob-covered (#861). Adding a worker-owned route is one edit to that list — the glob can no longer be forgotten.

### Discharging route requirements: `provideRequest`, not `Layer.provide`

`HttpRouter.add` lifts the handler's `R` into per-route requirement markers that plain `Layer.provide` does **not** discharge — they must be discharged with `HttpRouter.provideRequest` (ADR [0029](../.decisions/0029-worker-runtime-servicemap.md)). `makeAppLive` does this once, over dependency-free (`R = never`) layers built from the init-resolved services:

```ts
// worker/http/app.ts
const rawRoutes = Layer.mergeAll(...rawWorkerRouteLayers).pipe(
  HttpRouter.provideRequest(
    Layer.mergeAll(fateLayer, liveLayer, betterAuthLayer, flagsLayer, runtimeContextLayer),
  ),
);
return Layer.mergeAll(typedJson, rawRoutes);
```

`provideRequest` builds its layer **per request** — which is why everything passed in must already be init-resolved and dependency-free (`Layer.succeed` wrappers over clients resolved once in worker init), never a constructing layer like `BetterAuthLive`; the property contracts on `makeAppLive`'s options spell this out ([fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)).

### SSE responses

The live `GET /fate/live` returns the connection DO's streaming `Response` verbatim — `fromWeb` carries the stream through. The real route (`features/fate-live/route.ts`) reaches the DO through the init-resolved `LiveConnections` service, whose `open` wraps the stub `fetch` in the cold-start retry and surfaces a typed `LiveTransportError` → graceful 503:

```ts
export const handleLive = Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;
  const session = yield* pasaport.validateSession(raw.headers);
  if (!session) return liveError("UNAUTHORIZED", "Live views require a session.", 401);
  const connectionId = new URL(raw.url).searchParams.get("connectionId");
  // …build the forward Request (connectionId + ownerId + limits on the URL)…
  return yield* connections.open(connectionId, HttpServerRequest.fromWeb(forward)).pipe(
    Effect.catchTag("fate-live/LiveTransportError", (error) =>
      Effect.succeed(liveError("LIVE_UNAVAILABLE", error.message, 503)),
    ),
    Effect.orDie,   // only genuine request-framing errors stay defects
  );
});
```

Under the service, addressing is `connectionOf(live, connectionId).fetch(request)` — the stub `fetch` takes an `HttpServerRequest`, not a URL string + init, and the namespace exposes only `getByName` ([alchemy-durable-objects.md](./alchemy-durable-objects.md)). If you build a stream *in* the worker rather than a DO, `HttpServerResponse.stream(stream, {headers})` takes an Effect `Stream<Uint8Array>` directly. phoenix's live stream lives in the DO, so the worker just forwards.

> **This route is only the *inbound* half of live.** It opens the SSE connection; it says nothing about how mutations push updates back out. The publish path (mutation → topic instance → connection fan-out) is the `LiveTopics.publish` service over the same init-resolved namespace — see [alchemy-durable-objects.md](./alchemy-durable-objects.md).

## Assembling `fetch`

`makeAppLive({fateLayer, liveLayer, betterAuthLayer, flagshipLayer, runtimeContext, environment})` merges the typed group and the raw routes and returns `AppLive`; the worker body compiles it:

```ts
const AppLive = makeAppLive({…});
return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

> **`AppLive` mixes `HttpApiBuilder` groups and imperative `HttpRouter.add` routes in one app.** Both produce `Layer`s feeding the same router, so the composition type-checks and runs — the typed-JSON group (health) and the imperative raw-Request routes merge into the single `AppLive` the worker's `fetch` compiles from. The route-precedence / 404-catch-all / OPTIONS interplay between the two styles holds in the live worker.

CORS, when needed, is a layer too: `HttpRouter.cors({allowedOrigins, allowedMethods, allowedHeaders})` provided onto `AppLive`.

## Assets and worker-first precedence

The SPA is served by the worker's `assets` binding, not a route. But asset precedence still matters: with `notFoundHandling: "single-page-application"`, any path *not* listed in `runWorkerFirst` is answered by the asset server first — it returns the SPA shell for `GET /fate` (200) and **405** for `POST /fate`, and your route never runs. The assets prop is **flat** (`AssetsProps extends AssetsConfig {directory}` — `src/Cloudflare/Workers/Assets.ts`; no nested `config` key), and phoenix derives the globs from the route manifest:

```ts
// worker/index.ts
assets: {
  directory: "./dist/client",
  notFoundHandling: "single-page-application" as const,
  runWorkerFirst: [...workerFirstGlobs],   // derived from worker-routes.ts (#861)
},
```

> **Verify this in the running worker, not just tests.** Integration tests that hit the worker entry directly bypass the asset layer, so a missing `runWorkerFirst` entry passes tests and breaks in deploy. The lockstep test catches a forgotten glob structurally; still exercise `POST /fate` against the live worker.

## See also

- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — what the fate route does (the native interpreter on the request fiber + the per-request pair; the runtime is init-only wiring)
- [alchemy-worker.md](./alchemy-worker.md) — the `assets` prop and where `fetch` is returned
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the connection DO behind `/fate/live`
