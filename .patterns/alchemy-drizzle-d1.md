# Drizzle on D1

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.
> Derived from `drizzle-orm@1.0.0-rc.4` — re-verify on pin bump.
> Derived from `drizzle-kit@1.0.0-rc.4` — re-verify on pin bump.

How the query builder reaches the database. The short answer: bind the D1 connection in the worker's init phase via `Cloudflare.D1.QueryDatabase`, take its `raw` handle onto the **`Database` seam**, and derive the `Drizzle` service from that seam with `createDrizzle` — **once per isolate**, provided as a worker-level layer, never rebuilt per request. Migrations are **hand-authored** in the flat layout under `migrations/` and applied by alchemy through the D1 resource's `migrationsDir`; `drizzle-kit generate` is a scratch SQL aid only, not the incremental path (see [Migrations](#migrations) and [ADR 0108](../.decisions/0108-hand-authored-flat-d1-migrations.md)).

The `Drizzle.run` / `Drizzle.batch` callback surface that feature code uses (see [feature-services.md](./feature-services.md)) is unchanged. Only how the `drizzle` instance is constructed moves.

## From binding to a Drizzle instance

`Cloudflare.D1.QueryDatabase(PhoenixDb)` (beta.59's namespaced D1 module — the earlier flat `D1Connection.bind` is gone) resolves an Effect-native client whose `raw` field is the underlying Cloudflare `D1Database` that `drizzle-orm/d1` expects (`alchemy@2.0.0-beta.59` — `src/Cloudflare/D1/QueryDatabase.ts`, `QueryDatabaseClient.raw`: "Use this when you need direct access for libraries like Better Auth"):

```ts
// worker/db/Database.ts — the single seam holding the raw handle
export class Database extends Context.Service<Database, D1Database>()("@kampus/Database") {}

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const connection = yield* Cloudflare.D1.QueryDatabase(PhoenixDb);
    return yield* connection.raw;
  }),
);
```

The binding graph behind it (`Cloudflare.D1.QueryDatabaseBinding`) is provided once at worker scope (`worker/index.ts`, the final `Layer.provideMerge`); the worker's init phase then `yield* Database` once and wraps the resolved handle dependency-free (`Layer.succeed(Database)(raw)`) for the runtime build, so the routes never re-resolve the binding per request (ADR 0041).

Both `DrizzleLive` **and** the better-auth adapter derive from this same `Database` tag, so they provably share one underlying handle — the one-`sqlite` invariant is type-enforced by the layer graph (`R = Database`), not upheld by hand in tests.

## The `Drizzle` service, built once

RQB v2 (drizzle-orm 1.0) drives `db.query.<table>` off a **relations definition**, not `schema` alone — passing only `{schema}` leaves `db.query` empty. phoenix uses no cross-table `.with` traversal, so the single-arg `defineRelations(schema)` (empty relations) registers every table (`drizzle-orm@1.0.0-rc.4` — `relations.d.ts`, the one-arg `defineRelations` overload):

```ts
// worker/db/Drizzle.ts
export const relations = defineRelations(schema);
export const createDrizzle = (db: D1Database): DrizzleDb => drizzle(db, {relations});

export const DrizzleLive: Layer.Layer<Drizzle, never, Database> = Layer.effect(
  Drizzle,
  Effect.map(Database, (raw) => makeDrizzleAccess(createDrizzle(raw))),
);
```

`makeDrizzleAccess` is the single home of the `run`/`batch` bodies — the promise → Effect boundary (`Effect.tryPromise` object notation) and the tagged `DrizzleError` catch, in exactly one place. Feature services consume the surface through `orDieAccess`, which collapses `DrizzleError` into the defect channel at layer build so public method signatures carry domain errors only (see [effect-errors.md](./effect-errors.md) and [feature-services.md](./feature-services.md)). `DrizzleLive` is provided onto the feature stack in `worker/features/fate/layers.ts` (`Layer.provideMerge(DrizzleLive)`); `makeDrizzleLayer(db)` remains as the dependency-free constructor unit tests use.

> **Why once-per-isolate is correct.** The D1 binding is stable for the isolate's life, and `drizzle()` is a thin wrapper with no per-request state. Rebuilding it per request buys nothing on alchemy and costs an allocation; building it in init is both simpler and faster. The same logic makes the feature services worker-level singletons (ADR 0029, [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)).

## Hand-written SQL: the Effect-native client exists, phoenix doesn't use it

The bound client also carries Effect-native statements — `prepare(...).all/first/run/raw` (plan-building is synchronous; only executors round-trip), `exec`, and `batch` ("statements execute sequentially and are rolled back on failure") — all returning Effects with `RuntimeContext` in `R` (`alchemy@2.0.0-beta.59` — `src/Cloudflare/D1/QueryDatabase.ts`). Today phoenix routes **every** query through Drizzle: the client's only consumer is `DatabaseLive` taking `raw`. Reach for the statement surface only when a query is genuinely better expressed as raw SQL; inside a Durable Object there is no D1 at all — the `LiveDO` uses the DO's own `state.storage` KV API (see [alchemy-durable-objects.md](./alchemy-durable-objects.md)).

## Migrations

The schema lives at `worker/db/drizzle/schema.ts`. The author→apply pipeline is split: migrations are **hand-authored** in the flat layout, alchemy applies them on deploy.

```ts
// worker/db/resources.ts
export const PhoenixDb = Cloudflare.D1.Database("phoenix_db", {
  migrationsDir: "./worker/db/drizzle/migrations",
  migrationsTable: "drizzle_migrations",   // match drizzle-kit's bookkeeping table
});
```

The `D1.Database` resource lives in a module both the stack and the worker import (`worker/db/resources.ts`) so there's one definition — the stack ensures the DB exists (and `alchemy.run.ts` re-yields it to surface `databaseId`/`accountId` on the compiled output for the test harness, #692), the worker resolves it through `QueryDatabase`. On deploy, alchemy hashes `migrationsDir`, sorts the `.sql` files, and applies the pending set over the D1 HTTP API into a wrangler-compatible 3-column journal `(id, name, applied_at)` under `migrationsTable` (`alchemy@2.0.0-beta.59` — `src/Cloudflare/D1/Database.ts` update/create paths + `src/Cloudflare/D1/ApplyMigrations.ts`) — replacing the `wrangler d1 migrations apply` step. See [alchemy-stack-deploy.md](./alchemy-stack-deploy.md).

### Authoring a migration — hand-authored flat layout (ADR 0108)

The committed migrations use the **flat layout**: top-level `NNNN_name.sql`, a central `meta/_journal.json`, and per-migration `meta/NNNN_*_snapshot.json` (entries/snapshots `"version": "6"`). **Do not run `drizzle-kit generate` against the committed tree** — the catalog-pinned `drizzle-kit@1.0.0-rc.4` aborts with `Your migrations folder format is outdated, please run drizzle-kit up` because its `assertV3OutFolder` gate trips on the presence of `meta/_journal.json` (drizzle-kit 1.0 expects the per-migration-dir layout, not the legacy central journal; verified present in the rc.4 `bin.cjs`). Running `drizzle-kit up` would restructure **all** committed migrations — a history rewrite deferred to a single coordinated cutover ([ADR 0108](../.decisions/0108-hand-authored-flat-d1-migrations.md)).

To add a migration:

1. Author the SQL as a new flat `worker/db/drizzle/migrations/NNNN_name.sql`. `drizzle-kit generate` is usable **only** as a scratch aid — run it against an empty throwaway out-dir to get the SQL for a new table, then hand-place the emitted SQL into the flat file.
2. Append the entry to `meta/_journal.json` (`idx`, `version: "6"`, `when`, `tag`, `breakpoints`).
3. Add a `meta/NNNN_*_snapshot.json`. The snapshot JSON is **advisory** — it is read only by drizzle-kit's diff engine, never at apply time, so the load-bearing artifact is the `.sql`.

alchemy applies the committed `.sql` on deploy; the integration tier applies the full set against real D1.

### Dev binds D1 *remote* and applies *no* migrations

The load-bearing dev-vs-deploy fact: **`alchemy dev` applies no migrations, and there is no local D1.** In dev mode alchemy's local worker provider maps every `d1` binding to `D1.remote(...)` (`alchemy@2.0.0-beta.59` — `src/Cloudflare/Workers/LocalWorkerProvider.ts`, `toRuntimeBinding`, `case "d1"`), and the runtime package exports **only** `remote` for D1 (`@distilled.cloud/cloudflare-runtime@0.11.3` — `src/bindings/D1.ts`) — so even in dev the binding points at the real Cloudflare `phoenix_db`. Migrations apply **only** on `alchemy deploy` (over the D1 HTTP API, tracked in `drizzle_migrations`), or via the `pnpm db:migrate` escape hatch below. A developer reasonably expects a local D1 that `dev` migrates — there isn't one, so a freshly-authored migration is *unapplied* until one of those two paths runs.

To apply pending migrations short of a full `pnpm deploy`, run **`pnpm --filter @kampus/web db:migrate`** (`drizzle-kit migrate` against the `d1-http` driver). It reuses alchemy's own Cloudflare credentials plus the D1 UUID:

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… D1_DATABASE_ID=… \
  pnpm --filter @kampus/web db:migrate
```

`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` are the same pair `alchemy deploy` uses (see `.github/workflows/deploy.yml`); `D1_DATABASE_ID` is the `phoenix_db` UUID from the Cloudflare dashboard or `wrangler d1 list`. The credential block lives in `worker/db/drizzle.config.ts`'s `dbCredentials` — alchemy itself resolves the DB by name and ignores it; only `drizzle-kit migrate` reads it.

> **The orphaned `apps/web/.wrangler/state` sqlite is a footgun, not the dev DB.** `apps/web/.wrangler/state/v3/d1/…/<hash>.sqlite` is dead pre-alchemy-cutover wrangler-era state (`.wrangler/` is gitignored). Its journal table is `d1_migrations` — **wrangler's** name, not the `drizzle_migrations` `resources.ts` configures — which proves alchemy never wrote to it. But it *looks* like the dev DB, so reading it leads to the wrong conclusion "local D1 is stuck at 0000" (the false premise #546 was filed on). It is **not** the `alchemy dev` binding (which is remote, above). Safe to delete; if present, ignore it.

## better-auth on the same D1

`Pasaport` keeps using better-auth's Drizzle adapter. It reads the same `Database` seam, wraps the handle in its own RQB-v2 `drizzle` instance, and hands that to `drizzleAdapter` (`worker/features/pasaport/better-auth-live.ts`):

```ts
const raw = yield* Database;                              // the shared seam — one handle
const db = drizzle(raw, {relations: defineRelations(schema)});
const auth = makeBetterAuth({
  database: drizzleAdapter(db, {provider: "sqlite", schema}),
  // emailAndPassword, emailVerification, user, plugins, secret, …
});
```

The adapter is shape-only — it speaks the SQLite dialect, so it doesn't care that the handle is a D1 driver. The better-auth tables (`user`, `session`, `account`, …) are part of the same `schema.ts` and migrate through the same pipeline.

> **`experimental.joins` must stay off.** better-auth's drizzle adapter emits an RQB-**v1** raw-SQL `eq()` where-shape; our drizzle-orm 1.x is RQB-**v2** (`defineRelations`), which feeds that `where` into `relationsFilterToSQL` with no SQL pass-through — any better-auth read on the joins path 500s ("Unknown relational filter field"). The `drizzle-orm`/`better-auth` catalog pins are coupled by this incompatibility (see the `pnpm-workspace.yaml` catalog note; guard #2286, re-enable path #2291).

> **`makeBetterAuth` is built out of the request path.** `BetterAuthLive` constructs the instance **once** per isolate (`Effect.cached`), not per request — the worker-singleton model (ADR 0029, [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)), same as `Drizzle` and the feature services.

## See also

- [feature-services.md](./feature-services.md) — the `Drizzle.run`/`Drizzle.batch` callback surface + `orDieAccess`
- [alchemy-bindings.md](./alchemy-bindings.md) — the binding graph and the `raw` escape hatch
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — why `Drizzle` is a worker-level singleton
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — the D1 resource declaration + how alchemy applies committed migrations
- [ADR 0014](../.decisions/0014-drizzle-run-batch-as-service-methods.md) — the bound `run`/`batch` shape
- [ADR 0108](../.decisions/0108-hand-authored-flat-d1-migrations.md) — the hand-authored flat migration layout
