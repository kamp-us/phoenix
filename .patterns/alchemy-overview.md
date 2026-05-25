# alchemy-effect: the infra layer

How phoenix's Cloudflare infrastructure is declared and wired. The short answer: instead of `wrangler.jsonc` + a raw `export default {fetch}` worker + `env.PHOENIX_DB`-style binding access + hand-written Durable Object classes, the whole worker is **one Effect program** — [alchemy-effect](https://github.com/usirin/alchemy-effect) — where the same code that *declares* a binding at deploy time *is* the typed client at runtime.

> **These `alchemy-*` docs describe the target architecture for the alchemy-effect rebuild.** They are not (yet) the shape of `apps/web/worker/` — phoenix is mid-rebuild and not in production. The `effect-*` and `fate-*` docs describe the parts that survive the rebuild unchanged; these describe the new bottom layer that replaces wrangler + the manual worker entry. Where a doc and the source disagree, the source wins — fix the doc.

## This is not an Effect migration

phoenix is already on effect v4; so is alchemy-effect (`effect@4.0.0-*`). Nothing about the domain layer changes conceptually. What changes is the **seam between the domain and Cloudflare**:

| Concern | Today | On alchemy-effect |
|---|---|---|
| Bindings, DOs, migrations, assets | declared in `wrangler.jsonc` | declared as resources in one Effect program (`alchemy.run.ts` + the worker) |
| Reaching a binding | `env.PHOENIX_DB`, `env.CONNECTION_DO` | `yield* Cloudflare.D1Connection.bind(PhoenixDb)`, `yield* ConnectionDO` |
| Worker entry | `export default {fetch: app.fetch}` (Hono) | `export default class Phoenix extends Cloudflare.Worker<Phoenix>()(...)` |
| HTTP routing | Hono `app.get/post` | `HttpRouter` + `HttpApiBuilder` (`@effect/platform`) |
| Per-request runtime | `ManagedRuntime.make(...)` built + disposed per request | worker-level layers + a captured `ServiceMap` (no per-request runtime) |
| Durable Objects | plain `class extends DurableObject` | `Cloudflare.DurableObjectNamespace<T>()(...)` (Effect handlers) |
| Deploy | `wrangler deploy` | `alchemy deploy` |

**Unchanged:** every `effect-*` doc (services, errors, tracing, testing), and the *shape* of the `fate-*` protocol layer — data views, sources, mutations, the bridge helpers. The only fate change is what `FateContext` carries (a `ServiceMap` instead of a `ManagedRuntime`) — see [alchemy-runtime.md](./alchemy-runtime.md).

## The two phases

Every alchemy resource — a `Worker`, a `DurableObjectNamespace` — is defined by an outer Effect that runs in **two phases**:

```ts
export default class Phoenix extends Cloudflare.Worker<Phoenix>()(
  "phoenix",
  {main: import.meta.filename, assets: "./dist/client", /* … */},
  Effect.gen(function* () {
    // ── INIT PHASE (deploy time + once per isolate) ──
    // Bind resources. At deploy time this records binding metadata for the
    // Cloudflare API; at runtime it resolves typed clients.
    const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);
    const connections = yield* ConnectionDO;
    const topics = yield* TopicDO;

    return {
      // ── RUNTIME PHASE (per request) ──
      fetch: /* an Effect<HttpServerResponse, …> — usually HttpRouter.toHttpEffect(layer) */,
    };
  }).pipe(Effect.provide(/* binding Live layers */)),
) {}
```

The init phase is where `bind()` happens; the runtime phase is the handlers it returns. The single most important consequence: **bindings resolved in init are in scope for the whole worker lifetime**, so worker-wide singletons (the `Drizzle` service, the feature services) are built once in init, not per request. See [alchemy-runtime.md](./alchemy-runtime.md).

## How the layers map onto phoenix

phoenix has three layers (see [index.md](./index.md)). alchemy-effect slots in *under* them:

- **Effect domain layer** (`effect-*`) — services, errors, layers. Transport- *and* infra-agnostic. Untouched.
- **fate protocol + client layer** (`fate-*`) — data views, sources, mutations, live views. Untouched except the bridge's runtime handle.
- **alchemy infra layer** (these `alchemy-*` docs) — the worker, its bindings, the DOs, the HTTP router, deploy. **New.** Replaces `wrangler.jsonc` and `worker/index.ts`'s Hono shell.

## Reading order

1. [alchemy-worker.md](./alchemy-worker.md) — the `Cloudflare.Worker` class and its two phases.
2. [alchemy-bindings.md](./alchemy-bindings.md) — `bind()`, the deploy-policy/runtime-service split, the Live-layer convention.
3. [alchemy-runtime.md](./alchemy-runtime.md) — **the load-bearing doc.** Worker-level vs request-scoped layers, the captured `ServiceMap`, the fate bridge delta.
4. [alchemy-http-router.md](./alchemy-http-router.md) — `HttpRouter` + `HttpApiBuilder`, mounting fate/auth/SSE.
5. [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the Effect DO model; porting `ConnectionDO`/`TopicDO`.
6. [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — D1 + Drizzle + migrations.
7. [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — `alchemy.run.ts`, the `Stack`, dev/deploy.

## See also

- [effect-context-service.md](./effect-context-service.md) — the service model that rides on top, unchanged
- [fate-effect-bridge.md](./fate-effect-bridge.md) — the seam that gains a `ServiceMap` instead of a `ManagedRuntime`
- [alchemy-runtime.md](./alchemy-runtime.md) — start here for the runtime story
