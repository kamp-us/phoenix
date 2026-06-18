# Drizzle on D1

How the query builder reaches the database. The short answer: `bind` the D1 connection in the worker's init phase, take its `raw` handle, and hand that to `drizzle(raw, {schema})`. The `Drizzle` capability service is then built **once per isolate** from that instance and provided as a worker-level layer — not rebuilt per request. Migrations are generated **out-of-band** by `drizzle-kit` against `drizzle.config.ts` and applied by alchemy through the D1 resource's `migrationsDir`.

The `Drizzle.run` / `Drizzle.batch` callback surface that feature code uses (see [feature-services.md](./feature-services.md)) is unchanged. Only how the `drizzle` instance is constructed moves.

## From binding to a Drizzle instance

`Cloudflare.D1Connection.bind` returns an Effect-native client; its `raw` field is the underlying Cloudflare `D1Database` that `drizzle-orm/d1` expects:

```ts
// worker/index.ts (init phase)
import {drizzle} from "drizzle-orm/d1";
import * as schema from "./db/drizzle/schema";

const conn = yield* Cloudflare.D1Connection.bind(PhoenixDb);
const raw = yield* conn.raw;                 // the Cloudflare D1Database binding
const db = drizzle(raw, {schema});           // one instance for the isolate
```

`raw` is the documented escape hatch for exactly this — libraries that already speak the Cloudflare D1 dialect (Drizzle, better-auth) take it directly. You do **not** route Drizzle through `conn.prepare/all/first`; those are for hand-written SQL.

## The `Drizzle` service, built once

`DrizzleLive` does not read a per-request `CloudflareEnv`. It's a layer built from the already-constructed `db`, provided at worker scope:

```ts
// worker/db/Drizzle.ts
export interface DrizzleAccess {
  readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A, DrizzleError>;
  readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
    fn: (db: DrizzleDb) => T,
  ) => Effect.Effect<BatchResult<T>, DrizzleError>;
}

// constructed in the worker init from the bound db
export const makeDrizzleLayer = (db: DrizzleDb) =>
  Layer.succeed(Drizzle, {
    run: (fn) => Effect.tryPromise({try: () => fn(db), catch: (cause) => new DrizzleError({cause})}),
    batch: (fn) => Effect.tryPromise({try: () => db.batch(fn(db)), catch: (cause) => new DrizzleError({cause})}),
  });
```

Versus the old `Layer.effect(Drizzle)(Effect.gen(… yield* CloudflareEnv …))`: same `{run, batch}` shape, same `Effect.tryPromise` object-notation house rule, but the `db` arrives as an argument instead of being built from `env` on every request. The feature layers provide over it exactly as in [effect-layer-composition.md](./effect-layer-composition.md) — and all of it sits at worker scope per [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md).

> **Why once-per-isolate is correct.** The D1 binding is stable for the isolate's life, and `drizzle()` is a thin wrapper with no per-request state. Rebuilding it per request buys nothing on alchemy and costs an allocation; building it in init is both simpler and faster. The same logic makes the feature services worker-level singletons.

## Hand-written SQL still uses the connection

When a query is better expressed as raw SQL (a DO's registry, a one-off aggregate), use the bound connection's Effect-native statements rather than Drizzle — no `Effect.tryPromise` needed, the client is already Effect-returning:

```ts
const rows = yield* conn.prepare("SELECT id, name FROM users ORDER BY id").all<UserRow>();
const row  = yield* conn.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
yield* conn.batch([insert.bind(1, "a"), insert.bind(2, "b")]);   // sequential, rolled back on failure
```

Inside a Durable Object the embedded SQLite is `state.storage.sql.exec(...)` instead — different store, same idea. See [alchemy-durable-objects.md](./alchemy-durable-objects.md).

## Migrations

The schema lives at `worker/db/drizzle/schema.ts`. The generate→apply pipeline is split: `drizzle-kit` generates the SQL out-of-band, alchemy applies it on deploy.

```ts
// worker/db/resources.ts
export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {
  migrationsDir: "./worker/db/drizzle/migrations",
  migrationsTable: "drizzle_migrations",   // match drizzle-kit's bookkeeping table
});
```

The `D1Database` resource lives in a module both the stack and the worker import (`worker/db/resources.ts`) so there's one definition — the stack ensures the DB exists, the worker `bind()`s it. There is no `Drizzle.Schema` resource in the alchemy stack: migration SQL is generated against `drizzle.config.ts` (`pnpm --filter @kampus/web drizzle-kit generate`) and committed under `worker/db/drizzle/migrations/`. alchemy scans `migrationsDir` and applies new migrations on deploy — replacing the `wrangler d1 migrations apply` step, but not `drizzle-kit generate`. See [alchemy-stack-deploy.md](./alchemy-stack-deploy.md).

### Dev binds D1 *remote* and applies *no* migrations

The load-bearing dev-vs-deploy fact: **`alchemy dev` applies no migrations, and there is no local D1.** Under this alchemy + `@distilled.cloud/cloudflare-runtime` version the dev worker binds D1 as `D1.remote(...)` — the runtime exports only `remote`, so even in dev the binding points at the real Cloudflare `phoenix_db`. Migrations apply **only** on `alchemy deploy` (over the D1 HTTP API, tracked in `drizzle_migrations`), or via the `pnpm db:migrate` escape hatch below. A developer reasonably expects a local D1 that `dev` migrates — there isn't one, so a freshly-generated migration is *unapplied* until one of those two paths runs.

To apply pending migrations short of a full `pnpm deploy`, run **`pnpm --filter @kampus/web db:migrate`** (`drizzle-kit migrate` against the `d1-http` driver). It reuses alchemy's own Cloudflare credentials plus the D1 UUID:

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… D1_DATABASE_ID=… \
  pnpm --filter @kampus/web db:migrate
```

`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` are the same pair `alchemy deploy` uses (see `.github/workflows/deploy.yml`); `D1_DATABASE_ID` is the `phoenix_db` UUID from the Cloudflare dashboard or `wrangler d1 list`. The credential block lives in `worker/db/drizzle/drizzle.config.ts`'s `dbCredentials` — alchemy itself resolves the DB by name and ignores it; only `drizzle-kit migrate` reads it.

> **The orphaned `apps/web/.wrangler/state` sqlite is a footgun, not the dev DB.** `apps/web/.wrangler/state/v3/d1/…/<hash>.sqlite` is dead pre-alchemy-cutover wrangler-era state (`.wrangler/` is gitignored). Its journal table is `d1_migrations` — **wrangler's** name, not the `drizzle_migrations` `resources.ts` configures — which proves alchemy never wrote to it. But it *looks* like the dev DB (it even shows `0000_d1_baseline`), so reading it leads to the wrong conclusion "local D1 is stuck at 0000 / search is broken locally" (this is exactly the false premise #546 was filed on). It is **not** the `alchemy dev` binding (which is remote, above). Safe to delete; if present, ignore it.

## better-auth on the same D1

`Pasaport` keeps using better-auth's Drizzle adapter — it wraps the same `raw` binding in a `drizzle` instance and hands that to `drizzleAdapter`:

```ts
const raw = yield* conn.raw;                              // the Cloudflare D1Database binding
const auth = betterAuth({
  database: drizzleAdapter(drizzle(raw, {schema}), {provider: "sqlite", schema}),
  // emailAndPassword, user, plugins, secret, …
});
```

The adapter is shape-only — it speaks the SQLite dialect, so it doesn't care that `raw` is a D1 driver. The better-auth tables (`user`, `session`, `account`, …) are part of the same `schema.ts` and migrate through the same pipeline.

> **`createAuth` is built out of the request path.** `Pasaport` builds its `betterAuth` instance **once** when its layer is constructed (init phase), not per request inside `handleAuth`/`validateSession`. This follows the worker-singleton model ([ADR 0029](../.decisions/0029-worker-runtime-servicemap.md), [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)) — the same instance is reused across requests, consistent with how `Drizzle` and the feature services are worker-level singletons. The `betterAuth` instance has no per-request state; rebuilding it each call would only cost allocations.

## See also

- [feature-services.md](./feature-services.md) — the `Drizzle.run`/`Drizzle.batch` callback surface (unchanged)
- [alchemy-bindings.md](./alchemy-bindings.md) — `D1Connection.bind` and the `raw` escape hatch
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — why `Drizzle` is a worker-level singleton
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — the D1 resource declaration + how alchemy applies committed migrations
- [ADR 0014](../.decisions/0014-drizzle-run-batch-as-service-methods.md) — the bound `run`/`batch` shape
