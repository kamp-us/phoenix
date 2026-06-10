# HTTP routing

How requests are routed without Hono. The short answer: the worker's `fetch` is an `HttpRouter` compiled with `HttpRouter.toHttpEffect`. The typed JSON endpoint (`GET /api/health`) is an `HttpApiBuilder` group; raw-`Request` and SSE endpoints (`/fate`, `/api/auth/*`, `/fate/live`) are imperative `HttpRouter.add` routes that reach the raw request via `Cloudflare.Request` and return `HttpServerResponse.fromWeb`.

Everything here is `@effect/platform` (`effect/unstable/http`), the model alchemy's worker already speaks — so routes drop straight into `fetch` with no adapter.

## The shape of `fetch`

The worker returns `{fetch}` where `fetch: Effect<HttpServerResponse, …, HttpServerRequest | …>`. `HttpRouter.toHttpEffect(layer)` produces exactly that from a layer of routes:

```ts
return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

`AppLive` is a single `Layer` that registers every route. You assemble it from two sources — `HttpApiBuilder` groups and imperative `HttpRouter.add` routes — merged together.

## Typed JSON: `HttpApiBuilder` groups

For endpoints with a real request/response schema — phoenix's lone case is `GET /api/health` — define an `HttpApi` spec and implement it as a group. This gives schema-decoded params/bodies and typed responses for free.

```ts
// worker/http/health.ts
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

// success / payload / error are passed in the endpoint's options object —
// there is no `.setPayload(...)` builder. Responses are `Schema.Class`,
// payloads are `Schema.Struct`, errors are `Schema.TaggedErrorClass`.
export class HealthStatus extends Schema.Class<HealthStatus>("@phoenix/HealthStatus")({
  status: Schema.String,
  environment: Schema.NullOr(Schema.String),
}) {}

const health = HttpApiEndpoint.get("health", "/api/health", {success: HealthStatus});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}
export class HealthApi extends HttpApi.make("phoenix").add(HealthGroup) {}
```

`HttpApi.make(id)` and `HttpApiGroup.make(name)` return values with a variadic `.add(...)`; the `class … extends` form is the convention for naming them (it's what `HttpApiBuilder.group(HealthApi, "health", …)` references by name).

```ts
// worker/http/health.ts — the handler returns a typed HealthStatus
const healthGroup = HttpApiBuilder.group(HealthApi, "health", (h) =>
  h.handle("health", () =>
    Effect.gen(function* () {
      const {environment} = yield* AppConfig.pipe(Effect.orDie);
      return new HealthStatus({status: "ok", environment});
    }),
  ),
);
```

A payload-bearing endpoint adds a `payload` Schema to its options; `HttpApiBuilder` decodes the request body against it before the handler runs, so `{payload}` arrives already typed (see [effect-schema-validation.md](./effect-schema-validation.md)).

The group is itself a `Layer`. Compose it into `AppLive`:

```ts
const healthLive = HttpApiBuilder.layer(HealthApi).pipe(Layer.provide(healthGroup));
```

> **Workers have no `FileSystem`, so stub `HttpPlatform`.** `HttpApiBuilder.layer` pulls in `HttpPlatform` for file responses, which the Workers runtime can't satisfy. Provide a stub (and `Etag.layer`, `Path.layer`) or the layer won't build:
>
> ```ts
> const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
>   fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
>   fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
> });
> // …Layer.provide([Etag.layer, HttpPlatformStub, Path.layer])
> ```
>
> phoenix never serves files from the worker (the SPA comes from the `assets` binding), so the stub is always safe.

## Raw `Request` + SSE: imperative `HttpRouter.add`

fate's `handleRequest`, better-auth's handler, and the live SSE route all want the **raw** `Request`/`Response`, not a schema. Register them imperatively. The raw request is available as the `Cloudflare.Request` service; hand its result back with `HttpServerResponse.fromWeb`:

```ts
// worker/http/app.ts
const routesLive = Layer.mergeAll(
  // fate data plane — captures the service map, runs fate (alchemy-runtime.md)
  HttpRouter.add("POST", "/fate", handleFate),

  // better-auth — forward the raw Request to the auth handler
  HttpRouter.add("*", "/api/auth/*", Effect.gen(function* () {
    const raw = yield* Cloudflare.Request;
    const res = yield* Pasaport.handleAuth(raw);   // returns a web Response
    return HttpServerResponse.fromWeb(res);
  })),

  // live transport — hand off to the connection DO (alchemy-durable-objects.md)
  HttpRouter.add("*", "/fate/live", handleLive),
);
```

`HttpRouter.add(method, path, handler)` takes `"*"` for all methods, supports `:param` and `*` wildcards in the path, and accepts either an `Effect<HttpServerResponse, …>` or a `(request) => Effect<…>`. It returns a `Layer`, so it merges with the rest.

### SSE responses

The live `GET /fate/live` returns the connection DO's streaming `Response` verbatim — `fromWeb` carries the stream through:

```ts
const handleLive = Effect.gen(function* () {
  const raw = yield* Cloudflare.Request;
  const session = yield* Pasaport.validateSession(raw.headers);
  if (!session) return HttpServerResponse.text("unauthorized", {status: 401});
  const connectionId = new URL(raw.url).searchParams.get("connectionId")!;
  // Address the DO by NAME — the alchemy stub exposes only `getByName(name)`;
  // there is no `idFromName`/`idFromString`/`get` on the namespace.
  const stub = (yield* ConnectionDO).getByName(`connection:${connectionId}`);
  // `stub.fetch` takes an `HttpServerRequest`, not a URL string + init. Forward
  // the incoming request (build one from `raw` if you need to rewrite it):
  const res = yield* stub.fetch(HttpServerRequest.fromWeb(raw));   // DO returns the SSE stream
  return HttpServerResponse.fromWeb(res);
});
```

If you build a stream *in* the worker rather than a DO, `HttpServerResponse.stream(stream, {headers})` takes an Effect `Stream<Uint8Array>` directly. phoenix's live stream lives in the DO, so the worker just forwards — see [alchemy-durable-objects.md](./alchemy-durable-objects.md).

> **This route is only the *inbound* half of live.** It opens the SSE connection; it says nothing about how mutations push updates back out. The publish path (mutation → topic DO → connection fan-out) is a typed `TopicDO.publish(msg)` RPC with the namespace resolved in worker init and the fan-out fired via `waitUntil` from `yield* Cloudflare.WorkerExecutionContext` — see [alchemy-durable-objects.md](./alchemy-durable-objects.md) "live publish path".

## Assembling `fetch`

Merge the groups and routes, provide the platform layer, compile:

```ts
const AppLive = Layer.mergeAll(healthLive, routesLive).pipe(
  Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
);

return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

> **`AppLive` mixes `HttpApiBuilder` groups and imperative `HttpRouter.add` routes in one app.** Both produce `Layer`s feeding the same router, so the composition type-checks and runs — the typed-JSON group (health) and the imperative raw-Request routes (fate, auth, agents, live) merge into the single `AppLive` the worker's `fetch` compiles from. The route-precedence / 404-catch-all / OPTIONS interplay between the two styles holds in the live worker.

CORS, when needed, is a layer too: `HttpRouter.cors({allowedOrigins, allowedMethods, allowedHeaders})` provided onto `AppLive`.

## Assets and worker-first precedence

The SPA is served by the worker's `assets` binding, not a route. But asset precedence still matters: with `notFoundHandling: "single-page-application"`, any path *not* listed in `runWorkerFirst` is answered by the asset server first — it returns the SPA shell for `GET /fate` (200) and **405** for `POST /fate`, and your route never runs. List the worker-owned paths in the asset config:

```ts
assets: {
  directory: "./dist/client",
  config: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api/*", "/fate", "/fate/*"],
  },
},
```

> **Verify this in the running worker, not just tests.** Integration tests that hit the worker entry directly bypass the asset layer, so a missing `runWorkerFirst` entry passes tests and breaks in deploy. Exercise `POST /fate` against the live worker.

## See also

- [alchemy-runtime.md](./alchemy-runtime.md) — what `handleFate` does (the one runtime + per-request pair)
- [alchemy-worker.md](./alchemy-worker.md) — the `assets` prop and where `fetch` is returned
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the connection DO behind `/fate/live`
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — the compiled fate server and the request context it receives
