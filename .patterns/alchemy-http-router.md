# HTTP routing

How requests are routed without Hono. The short answer: the worker's `fetch` is an `HttpRouter` compiled with `HttpRouter.toHttpEffect`. Typed JSON endpoints (health, `/api/admin/*`) are `HttpApiBuilder` groups; raw-`Request` and SSE endpoints (`/fate`, `/api/auth/*`, `/fate/live`) are imperative `HttpRouter.add` routes that reach the raw request via `Cloudflare.Request` and return `HttpServerResponse.fromWeb`.

Everything here is `@effect/platform` (`effect/unstable/http`), the model alchemy's worker already speaks — so routes drop straight into `fetch` with no adapter.

## The shape of `fetch`

The worker returns `{fetch}` where `fetch: Effect<HttpServerResponse, …, HttpServerRequest | …>`. `HttpRouter.toHttpEffect(layer)` produces exactly that from a layer of routes:

```ts
return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

`AppLive` is a single `Layer` that registers every route. You assemble it from two sources — `HttpApiBuilder` groups and imperative `HttpRouter.add` routes — merged together.

## Typed JSON: `HttpApiBuilder` groups

For endpoints with a real request/response schema — `GET /api/health`, the `/api/admin/*` seeders — define an `HttpApi` spec and implement it as a group. This gives schema-decoded params/bodies and typed responses for free.

```ts
// worker/http/admin-api.ts
import {HttpApi, HttpApiEndpoint, HttpApiGroup} from "effect/unstable/httpapi";
import {Schema} from "effect/schema";

export class AdminApi extends HttpApi.make("admin").add(
  HttpApiGroup.make("sozluk")
    .add(HttpApiEndpoint.post("upsertTerm", "/api/admin/sozluk/upsert-term").setPayload(UpsertTerm))
    .add(HttpApiEndpoint.post("clear", "/api/admin/sozluk/clear")),
) {}
```

```ts
// worker/http/admin-handlers.ts
const sozlukGroup = HttpApiBuilder.group(AdminApi, "sozluk", (h) =>
  h
    .handle("upsertTerm", ({payload}) =>
      Effect.gen(function* () {
        yield* AdminAuth.required;                 // env-gated; Forbidden → 403
        const admin = yield* SozlukAdmin;
        return yield* admin.seedTerm(payload);
      }).pipe(Effect.provideService(AdminAuth, adminAuthOf())),
    )
    .handle("clear", () => /* … */),
);
```

The group is itself a `Layer`. Compose it into `AppLive`:

```ts
const adminLive = HttpApiBuilder.layer(AdminApi).pipe(Layer.provide(sozlukGroup));
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
  // fate data plane — captures the ServiceMap, runs fate (alchemy-runtime.md)
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
  const stub = (yield* ConnectionDO).getByName(`connection:${connectionId}`);
  const res = yield* stub.fetch(/* …connect request… */);   // DO returns the SSE stream
  return HttpServerResponse.fromWeb(res);
});
```

If you build a stream *in* the worker rather than a DO, `HttpServerResponse.stream(stream, {headers})` takes an Effect `Stream<Uint8Array>` directly. phoenix's live stream lives in the DO, so the worker just forwards — see [alchemy-durable-objects.md](./alchemy-durable-objects.md).

## Assembling `fetch`

Merge the groups and routes, provide the platform layer, compile:

```ts
const AppLive = Layer.mergeAll(adminLive, healthLive, routesLive).pipe(
  Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
);

return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
```

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

- [alchemy-runtime.md](./alchemy-runtime.md) — what `handleFate` does (capture + bridge)
- [alchemy-worker.md](./alchemy-worker.md) — the `assets` prop and where `fetch` is returned
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the connection DO behind `/fate/live`
- [fate-server-wiring.md](./fate-server-wiring.md) — `createFateServer` and the `adapterContext` it receives
