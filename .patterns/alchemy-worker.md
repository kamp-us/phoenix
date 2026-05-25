# The Cloudflare Worker

How the single phoenix worker is defined. The short answer: `export default class Phoenix extends Cloudflare.Worker<Phoenix>()("phoenix", props, body)`. The `body` is an Effect that runs in two phases — bind resources in the init phase, return handlers in the runtime phase — and the binding Live layers it needs are provided onto the body with `Effect.provide`.

This is `worker/index.ts` — there is no `wrangler.jsonc` and no Hono `export default {fetch}` entry.

## The class-factory shape

`Cloudflare.Worker<Self>()` returns a class factory; you `extends` its call. The self-type parameter is what lets *other* workers and the stack reference this worker as a typed resource.

```ts
// worker/index.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {PhoenixDb} from "./infra/resources";
import ConnectionDO from "./fate/connection-do";
import TopicDO from "./fate/topic-do";

export default class Phoenix extends Cloudflare.Worker<Phoenix>()(
  "phoenix",
  {
    main: import.meta.filename,
    assets: "./dist/client",
    compatibility: {flags: ["nodejs_compat"]},
    observability: {enabled: true},
  },
  Effect.gen(function* () {
    // init phase — see below
    const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);
    const connections = yield* ConnectionDO;
    const topics = yield* TopicDO;

    return {fetch: /* runtime phase */};
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive)),
  ),
) {}
```

The three positional args are: an `id` (the Cloudflare script name), a `props` object, and the `body` Effect.

## Props

The props object replaces the top of `wrangler.jsonc`:

- **`main: import.meta.filename`** — entry module. Always this.
- **`assets`** — the SPA. Either a string path (`"./dist/client"`) or `{directory, config}`. The `config` is Cloudflare's native asset config, passed through verbatim, so SPA routing and worker-first precedence live here — see [alchemy-http-router.md](./alchemy-http-router.md) for the exact `notFoundHandling` / `runWorkerFirst` settings phoenix needs.
- **`compatibility: {flags, date}`** — `["nodejs_compat"]` (phoenix uses it for better-auth + drizzle).
- **`observability: {enabled: true}`** — tail logs.

There is no `bindings`/`durable_objects`/`d1_databases`/`migrations` key here. Bindings are wired by `bind()` calls in the body (this doc) and by declaring the resources in the stack ([alchemy-stack-deploy.md](./alchemy-stack-deploy.md)); DO migrations are derived from the `DurableObjectNamespace` declarations.

## Vite & the SPA — one worker, not `Cloudflare.Vite`

phoenix is **one worker that serves both** the React SPA and the hand-written API/fate/DO backend on a single URL. That shape is `Cloudflare.Worker` with `assets` — *not* `Cloudflare.Vite`:

- **`Cloudflare.Worker` + `assets`** (phoenix's shape) — the hand-written `main` is the backend; `assets: "./dist/client"` uploads the SPA Vite built. `runWorkerFirst` routes `/api/*` and `/fate*` to the worker, everything else to the assets ([alchemy-http-router.md](./alchemy-http-router.md)). The Vite build of the client is a normal build step — `vite build → dist/client`, then `pnpm build && alchemy deploy`.
- **`Cloudflare.Vite`** — *wrong tool here.* It sets `main: undefined`: it's assets-only for SPAs, or the framework's entry for SSR. It can't host phoenix's backend on the same worker; using it forces a two-worker split (an assets-only `Web` worker + a bound `Backend` worker, two URLs), abandoning the single-surface model.

> **No `@cloudflare/vite-plugin` in `vite.config.ts`.** alchemy ships its own Cloudflare integration and is **not compatible** with `@cloudflare/vite-plugin`, so the `cloudflare()` plugin is gone. Everything else in the config stays: `react()`, the **`fate()` codegen plugin**, aliases, tsconfig all work (the `fate()` plugin is orthogonal to Cloudflare — it reads the server's `Entity<>` types regardless of how the worker deploys).

> **Local dev is two processes, by design — still one worker.** `alchemy dev` runs this worker against a local workerd runtime with live bindings and watch-rebuilds the backend, but with `Cloudflare.Worker` + `assets` it serves `dist/client` *statically* (no client HMR — that lives only on the `Cloudflare.Vite` path, which can't host an Effect-native worker). So client HMR comes from running the SPA's `vite dev` alongside `alchemy dev`, with Vite proxying `/api` and `/fate*` to the worker. The second terminal is the Vite dev server, **not** a second worker — it's gone at deploy, where one worker serves both. This is phoenix's chosen dev model; the constraint and proxy config are in [alchemy-stack-deploy.md](./alchemy-stack-deploy.md#local-dev--two-processes-the-decided-model).

## Init phase — bind resources

The outer `Effect.gen` body runs at deploy time (to record what to send the Cloudflare API) and once per isolate at runtime (to resolve typed clients). Everything you `yield*` here is in scope for the worker's whole lifetime:

```ts
Effect.gen(function* () {
  const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);  // typed D1 client
  const connections = yield* ConnectionDO;                    // typed DO namespace
  const topics = yield* TopicDO;
  // …build worker-level services from these (Drizzle, features) — alchemy-runtime.md
})
```

Two binding flavors show up here — `yield* SomeDO` for Durable Objects vs `yield* Cloudflare.X.bind(resource)` for D1/R2/KV. [alchemy-bindings.md](./alchemy-bindings.md) explains why they differ.

> **Build worker-wide singletons in init, not per request.** The bound `db` is stable for the isolate's life, so the `Drizzle` capability service and the feature services (Sozluk, Pano, …) are constructed once here and provided as worker-level layers. Only request-scoped values (`Auth`, `RequestContext`) are provided per request. This is the central difference from the old "rebuild a `ManagedRuntime` every request" design — see [alchemy-runtime.md](./alchemy-runtime.md).

## Runtime phase — return handlers

The body returns an object of handlers. phoenix only needs `fetch`, which must be an `Effect<HttpServerResponse, …>`. In practice you never hand-write that Effect — you compile a router into it:

```ts
return {
  fetch: router.pipe(HttpRouter.toHttpEffect),
};
```

`HttpRouter.toHttpEffect(layer)` turns a layer of routes into exactly the `Effect<HttpServerResponse, …, HttpServerRequest | …>` the worker expects. See [alchemy-http-router.md](./alchemy-http-router.md). (Other handler slots exist — `scheduled`, `queue`, `email` — phoenix doesn't use them yet.)

## Providing binding Live layers

A `bind()` call has a runtime dependency: the *binding service's* Live layer (e.g. `Cloudflare.D1ConnectionLive` backs `Cloudflare.D1Connection.bind`). Provide them onto the body:

```ts
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1ConnectionLive,
        // Cloudflare.R2BucketBindingLive, KVNamespaceBindingLive, … when those bindings appear
      ),
    ),
  ),
```

> **Forgetting the Live layer is a type error, not a runtime surprise.** `bind()` requires its binding service in the Effect's `R` channel; if you don't provide the matching `…Live`, the worker body won't type-check. The compiler tells you exactly which binding is unwired.

## What lives where

- `worker/index.ts` — this class. Thin: bind resources, build worker-level layers, mount the router.
- `worker/infra/resources.ts` — the resource *declarations* (`PhoenixDb = Cloudflare.D1Database("phoenix_db")`) shared between the worker and the stack.
- `alchemy.run.ts` — the stack that deploys this worker. See [alchemy-stack-deploy.md](./alchemy-stack-deploy.md).

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — `bind()` and the Live-layer convention
- [alchemy-runtime.md](./alchemy-runtime.md) — worker-level vs request-scoped layers; the captured service map
- [alchemy-http-router.md](./alchemy-http-router.md) — building the router that becomes `fetch`
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — declaring resources and deploying this worker
