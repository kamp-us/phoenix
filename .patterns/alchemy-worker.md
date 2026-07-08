# The Cloudflare Worker

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

How the single phoenix worker is defined. The short answer: the worker splits into a class **Tag** — `export class Phoenix extends Cloudflare.Worker<Phoenix, {}, LiveDO>()("phoenix") {}` — and an implementation **Layer** — `export default Phoenix.make(props, body)`. The `body` is an Effect that runs in two phases (bind resources in the init phase, return handlers in the runtime phase), and the binding Layers it needs are provided onto it with one combined `Effect.provide`.

This is `worker/index.ts` — there is no `wrangler.jsonc` and no Hono `export default {fetch}` entry.

## The three authoring forms — phoenix uses the Layer form

alchemy defines three ways to author a worker (`alchemy@2.0.0-beta.59 — src/Cloudflare/Workers/Worker.ts`, the "Async Workers" / "Effect Workers" / "Worker Layer" doc sections):

- **Async** — `main` points at a plain `async fetch` file; no Effect runtime in the bundle.
- **Effect (inline)** — `Cloudflare.Worker<Self>()(id, props, impl)`: three positional args, everything in one file.
- **Layer (modular)** — `Cloudflare.Worker<Self, Shape, Deps>()(id)` declares the Tag (name + RPC shape + hosted dependencies); `Self.make(props, impl)` returns the implementation Layer as the file's `export default`. Rolldown treats `.make()` as pure, so a consumer that imports the class for binding tree-shakes the implementation away.

phoenix must use the Layer form: only the modular overload takes the `Deps` type parameter, and `Phoenix` declares the hosted `LiveDO` as its `Deps` so the body can `yield*` the DO Tag in init and provide `LiveDOLive` (ADR [0028](../.decisions/0028-effect-durable-object-model.md)):

```ts
// worker/index.ts
export class Phoenix extends Cloudflare.Worker<
  Phoenix,
  {},      // no RPC beyond fetch (alchemy's empty-shape sentinel)
  LiveDO   // the hosted DO, declared as Deps
>()("phoenix") {}

export default Phoenix.make(
  phoenixProps,
  Effect.gen(function* () {
    // init phase — see below
    return {fetch: /* runtime phase */};
  }).pipe(Effect.provide(/* binding Layers — see below */)),
);
```

The stack (`alchemy.run.ts`) imports both: `yield* Phoenix` deploys the worker, `Effect.provide(PhoenixLive)` (the default export) resolves the Tag — see [alchemy-stack-deploy.md](./alchemy-stack-deploy.md).

## Props — a value or an Effect

`make(props, impl)` accepts the props as a plain object **or** as an `Effect` (`alchemy@2.0.0-beta.59 — src/Cloudflare/Workers/Worker.ts`, the modular `make<PropsReq>` overload). phoenix's props are an Effect so `domain` can derive from the deploy's `Stage` — but that Effect **re-runs at isolate init**, where deploy-only services (`Stage`) are absent, so every deploy-only derivation is gated on `ALCHEMY_PHASE === "plan"` (alchemy bakes `ALCHEMY_PHASE: "runtime"` into the deployed worker). The full rationale is on `phoenixProps` in `worker/index.ts`.

The props phoenix sets (all from `WorkerProps`, same file):

- **`main: import.meta.filename`** — entry module. Always this.
- **`assets`** — the SPA. Either a string path or a **flat** `AssetsProps` — `{directory, ...AssetsConfig}`, i.e. `notFoundHandling` / `runWorkerFirst` sit beside `directory`, **not** nested under a `config` key (`src/Cloudflare/Workers/Assets.ts` — `AssetsProps extends AssetsConfig {directory}`). phoenix derives `runWorkerFirst` from the route manifest — see [alchemy-http-router.md](./alchemy-http-router.md).
- **`env`** — env bindings. Accepts resource references (emitted as native bindings — phoenix binds the `Flagship` app and the AE `Events` dataset here), `effect/Config` values (resolved at deploy, bound as `secret_text`), and literals routed by shape: `Redacted<string>` → `secret_text`, `string` → `plain_text`, anything else → `json`. Runtime reads the same values off the ConfigProvider alchemy auto-wires — the bind↔read seam is single-sourced in `worker/config.ts` (`ENV_BINDINGS`); see [worker-environment-pattern.md](./worker-environment-pattern.md).
- **`compatibility: {flags, date}`** — `["nodejs_compat"]` (better-auth + drizzle).
- **`dev: {port: 1337, strictPort: true}`** — pin the local `alchemy dev` port; the default (1337) silently falls back to the next free port, which would misroute the Vite proxy.
- **`placement: {mode: "smart"}`** — Smart Placement toward the D1 primary (ADR [0168](../.decisions/0168-d1-region-strategy-smart-placement-first.md)).
- **`observability`** — declared explicitly (`{enabled, headSamplingRate: 1, logs: {enabled, invocationLogs}}`) even though alchemy defaults observability **on** when the prop is omitted (`WorkerProps.observability` docs) — legibility over lean-on-default. Field names are the CF camelCase, not wrangler snake_case.
- **`domain`** — Custom Domain(s), production-only and plan-phase-only (see above).

Also available when needed: `crons` (phoenix instead registers its Cron Trigger through `Cloudflare.cron(...)` — see below), `url`, `limits`, `bundle: false` + `rules` for prebuilt entries, `script` for inline workers.

There is no `bindings`/`durable_objects`/`d1_databases`/`migrations` key. Native bindings are wired by the capability-service calls in the body (see [alchemy-bindings.md](./alchemy-bindings.md)) and by declaring the resources in the stack; DO migrations derive from the DO declarations.

## Vite & the SPA — one worker, not the Vite resource

phoenix is **one worker that serves both** the React SPA and the hand-written API/fate/DO backend on a single URL. That shape is `Cloudflare.Worker` with `assets` — *not* alchemy's Vite integration:

- **`Cloudflare.Worker` + `assets`** (phoenix's shape) — the hand-written `main` is the backend; `assets: {directory: "./dist/client", …}` uploads the SPA Vite built. `runWorkerFirst` routes the worker-owned paths to the worker, everything else to the assets ([alchemy-http-router.md](./alchemy-http-router.md)). The client build is a normal step — `vite build → dist/client`, then `pnpm build && alchemy deploy`.
- **alchemy's Vite integration** (`Cloudflare.Website.Vite`, backed by `src/Cloudflare/Workers/Vite.ts` + alchemy's own `@distilled.cloud/cloudflare-vite-plugin` fork) — *wrong tool here.* It owns the whole Vite build/dev pipeline for a framework app; it can't host phoenix's hand-written Effect backend on the same worker, so using it forces a two-worker split (an assets worker + a bound backend worker), abandoning the single-surface model.

> **No `@cloudflare/vite-plugin` in `vite.config.ts`.** That plugin only drives alchemy's *other* worker shape (the Vite-resource pipeline above), so it's gone from phoenix's config. Everything else stays: `react()`, the **`fate()` codegen plugin**, aliases, tsconfig (the `fate()` plugin is orthogonal to Cloudflare — it reads the server's `Entity<>` types regardless of how the worker deploys). See the rationale block at the top of `apps/web/vite.config.ts`.

> **Local dev is two processes, by design — still one worker.** `alchemy dev` runs this worker against a local workerd with live bindings and watch-rebuilds the backend, but with `Cloudflare.Worker` + `assets` it serves `dist/client` *statically* (no client HMR). So client HMR comes from running the SPA's `vite dev` alongside `alchemy dev`, with Vite proxying the worker-owned paths to the worker. The second terminal is the Vite dev server, **not** a second worker — it's gone at deploy. The constraint and proxy config are in [alchemy-stack-deploy.md](./alchemy-stack-deploy.md#local-dev--two-processes-the-decided-model).

## Init phase — bind resources

The body's outer `Effect.gen` runs at deploy time (to record what to send the Cloudflare API) and once per isolate at runtime (to resolve typed clients). Everything you `yield*` here is in scope for the worker's whole lifetime:

```ts
Effect.gen(function* () {
  const live = yield* LiveDO;                                  // typed DO namespace
  const raw = yield* Database;                                 // raw D1 via the Database seam (ADR 0040)
  const flagship = yield* Flagship;                            // Effect-native FlagshipClient
  const telemetry = yield* Cloudflare.AnalyticsEngine.WriteDataset(TelemetryEvents);
  // …build worker-level services from these — fate-effect-worker-wiring.md
})
```

Two binding flavors show up here — `yield* SomeDO` for Durable Objects vs `yield* Cloudflare.<Product>.<Capability>(resource)` for everything else (D1, AE, Flagship, …). [alchemy-bindings.md](./alchemy-bindings.md) explains the model.

> **Build worker-wide singletons in init, not per request.** The bound clients are stable for the isolate's life, so the `Drizzle` capability service and the feature services (Sozluk, Pano, …) are constructed once here and provided as worker-level layers. Only request-scoped values are provided per request; `HttpServerRequest` comes from the upstream `effect/unstable/http/HttpServerRequest` Tag the alchemy runtime already provides. See [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md).

> **No async/timer work in init.** Workerd disallows it in global scope — forcing a layer build in init stalls the worker before it can serve. The fate layer builds lazily on the first request (`worker/index.ts`, the "NO init-time warmup" note). Registering listeners is init-safe: the sıcak-decay Cron Trigger subscribes in init via `Cloudflare.cron(expression, handler)` (`src/Cloudflare/Workers/CronEventSource.ts`), which attaches the cron expression at deploy and registers the `scheduled` listener at runtime — the worker never returns a `scheduled` handler slot by hand.

## Runtime phase — return handlers

The body returns an object of handlers. phoenix only needs `fetch`. The slot accepts an `HttpEffect` **or an Effect that yields one** — `HttpEffect = Effect<HttpServerResponse, HttpServerError | HttpBodyError, HttpServerRequest | Scope | Req>` (`alchemy@2.0.0-beta.59 — src/Http.ts`; `makeRequestEffect` in `src/Cloudflare/Workers/HttpServer.ts` takes `HttpEffect<Req> | Effect<HttpEffect<Req>>`). In practice you never hand-write it — you compile a router:

```ts
return {
  fetch: AppLive.pipe(HttpRouter.toHttpEffect),
};
```

`HttpRouter.toHttpEffect(layer)` turns a layer of routes into exactly that Effect-of-`HttpEffect`. See [alchemy-http-router.md](./alchemy-http-router.md). Other handler slots exist — the full set is alchemy's `ExportedHandlerMethods`: `fetch`, `tail`, `trace`, `tailStream`, `scheduled`, `test`, `email`, `queue` (`src/Cloudflare/Workers/Worker.ts`) — phoenix returns only `fetch` (its `scheduled` listener rides `Cloudflare.cron`, above). The deployed worker also wraps `fetch` in the Sentry request handler when a DSN is bound (ADR 0118) — see the runtime-phase block in `worker/index.ts`.

## Providing binding Layers

Each capability-service call has a runtime dependency: its binding Layer (e.g. `Cloudflare.D1.QueryDatabaseBinding` backs `Cloudflare.D1.QueryDatabase`). Provide them onto the body in **one combined** `Effect.provide` (chaining multiple provides can break layer lifecycle):

```ts
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      LiveDOLive,                                              // the hosted DO (alchemy-durable-objects.md)
      BetterAuthLive.pipe(Layer.provideMerge(DatabaseLive), …),
      FlagshipLive.pipe(Layer.provide(Cloudflare.Flagship.ReadFlagsBinding)),
      Cloudflare.AnalyticsEngine.WriteDatasetBinding,
      Cloudflare.CronEventSourceLive,
    ).pipe(Layer.provideMerge(Cloudflare.D1.QueryDatabaseBinding)),
  ),
),
```

> **Forgetting a binding Layer is a type error, not a runtime surprise.** A capability-service call requires its service in the Effect's `R` channel; if you don't provide the matching `…Binding` layer, the worker body won't type-check. The compiler tells you exactly which binding is unwired.

## What lives where

- `worker/index.ts` — the `Phoenix` Tag, `phoenixProps`, and `Phoenix.make(...)`. Thin: bind resources, build worker-level layers, mount the router.
- `worker/db/resources.ts` — the resource *declarations* (`PhoenixDb = Cloudflare.D1.Database("phoenix_db", {migrationsDir, migrationsTable})`) shared between the worker and the stack. Feature-owned resources sit beside their feature (`features/flagship/resources.ts`, `features/telemetry/resources.ts`).
- `alchemy.run.ts` — the stack that deploys this worker (and provides `PhoenixLive`). See [alchemy-stack-deploy.md](./alchemy-stack-deploy.md).

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — the capability-service binding model and the `…Binding` layer convention
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — worker-level vs request-scoped layers; the captured service map
- [alchemy-http-router.md](./alchemy-http-router.md) — building the router that becomes `fetch`
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — declaring resources and deploying this worker
- [worker-environment-pattern.md](./worker-environment-pattern.md) — the `env` prop ↔ `effect/Config` seam
