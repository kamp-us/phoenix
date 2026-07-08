# Bindings

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

How phoenix reaches Cloudflare resources. The short answer: a binding is a **capability service** — `yield* Cloudflare.<Product>.<Capability>(resource)` in the worker's init phase does two jobs: at **deploy time** it records the binding's metadata for the Cloudflare API; at **runtime** it resolves a typed, Effect-wrapped client. You use the result in handlers. There is no `env.PHOENIX_DB`.

## Two phases, one call

Every capability's implementation layer has two halves (the shape is uniform — see `alchemy@2.0.0-beta.59 — src/Cloudflare/D1/QueryDatabaseBinding.ts` for the canonical instance):

- **deploy-time** — under `if (!globalThis.__ALCHEMY_RUNTIME__)`, it calls `host.bind` to record `{type, name, …}` so alchemy sends the right binding to the Cloudflare API. A no-op at runtime.
- **runtime** — it resolves the live binding off `WorkerEnvironment` by the resource's `LogicalId` and wraps it in the typed client.

You write the call once; the same expression contributes the binding at deploy and the client at runtime. This is why infra and app code can share one program.

## Two binding shapes

phoenix sees two forms. They differ by whether the resource *is* a service.

**`yield* Cloudflare.<Product>.<Capability>(resource)`** — for D1, R2, KV, AE, Flagship, Email, …. The capability is a `Binding.Service` (a combined Context tag + callable — `src/Binding.ts`); calling it with the resource resolves the client. The capability name encodes the access grant, least-privilege style — `D1.QueryDatabase`, `AnalyticsEngine.WriteDataset`, `Flagship.ReadFlags`, `KV.ReadWriteNamespace`, `R2.ReadWrite`:

```ts
const db = yield* Cloudflare.D1.QueryDatabase(PhoenixDb);
// db: QueryDatabaseClient — prepare/exec/batch/raw, all Effect-returning
const events = yield* Cloudflare.AnalyticsEngine.WriteDataset(TelemetryEvents);
```

**`yield* SomeDurableObject`** — for Durable Objects. The DO class Tag *is* the resource and the binding; yielding it gives the typed stub factory:

```ts
const live = yield* LiveDO;
const stub = live.getByName("topic:pano:posts");
yield* stub.publish(input);            // typed RPC
```

See [alchemy-durable-objects.md](./alchemy-durable-objects.md) for the DO side and [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) for D1.

## The `…Binding` layer convention

A capability call needs its implementation **layer** in scope. Provide it onto the worker body (one combined `Effect.provide` — [alchemy-worker.md](./alchemy-worker.md)):

```ts
Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(PhoenixDb);
  // …
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
```

The naming is mechanical: capability `X` → layer `XBinding` — `QueryDatabase` → `QueryDatabaseBinding`, `WriteDataset` → `WriteDatasetBinding`, `ReadFlags` → `ReadFlagsBinding`, `Email.Send` → `Email.SendBinding`. (Event sources are the exception: `Cloudflare.cron`'s runtime seam is `CronEventSourceLive`.) If you add a binding and forget its layer, the worker body fails to type-check — the capability service shows up unsatisfied in the Effect's `R` channel.

> **Durable Objects don't take a `…Binding` layer.** `yield* LiveDO` resolves the namespace directly; what you provide instead is the DO's own implementation Layer (`LiveDOLive` from `LiveDO.make(...)`) since phoenix hosts it. Only the capability-style bindings have a separate binding layer.

## phoenix's bindings

| Resource | Declaration | Bound as | Backed by |
|---|---|---|---|
| `PhoenixDb` | `Cloudflare.D1.Database("phoenix_db", {migrationsDir, migrationsTable})` | `Cloudflare.D1.QueryDatabase(PhoenixDb)` (via the `Database` seam, ADR 0040) | `Cloudflare.D1.QueryDatabaseBinding` |
| `LiveDO` | `Cloudflare.DurableObject<LiveDO, LiveRpcSurface>()("LiveDO")` | `yield* LiveDO` | `LiveDOLive` (the DO's own `.make` Layer) |
| `Flagship` app | `features/flagship/resources.ts`, also in the `env` prop | `Cloudflare.Flagship.ReadFlags(...)` (via the `Flagship` seam) | `Cloudflare.Flagship.ReadFlagsBinding` |
| `Events` AE dataset | `features/telemetry/resources.ts`, also in the `env` prop | `Cloudflare.AnalyticsEngine.WriteDataset(TelemetryEvents)` | `Cloudflare.AnalyticsEngine.WriteDatasetBinding` |
| `send_email` | `features/pasaport/email-resources.ts` (production-only, ADR 0101) | prod `EmailSender` adapter | `Cloudflare.Email.SendBinding` |
| Env vars (`ENVIRONMENT`, `BETTER_AUTH_SECRET`, `SENTRY_DSN`) | the `env` prop, names single-sourced in `worker/config.ts` | `yield* AppConfig` / the `Config` constants (auto-wired ConfigProvider) | — |

R2/KV are not used yet; when they appear, declare the resource in the stack, call the capability in init, and provide its `…Binding` layer.

## The clients are Effect-native

Bound clients return Effects, not promises — they compose into service methods directly:

```ts
const rows = yield* db.prepare(sql).bind(id).all<Row>();   // Effect<…>
yield* events.writeDataPoint({blobs, doubles, indexes});   // Effect<void, …>
```

For D1 specifically, prepared-statement construction (`prepare`, `bind`) is synchronous (plan-building); only `all`/`first`/`run`/`raw`/`batch` round-trip (`src/Cloudflare/D1/QueryDatabase.ts`). The `raw` escape hatch is itself an Effect resolving the underlying Cloudflare `D1Database` binding, for libraries that want it (Drizzle, better-auth) — see [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md).

> **beta.59 colors runtime client methods with `RuntimeContext`.** `raw`, DO storage/RPC, `Email.Send`'s `.send`, … carry a `RuntimeContext` requirement (ADR [0124](../.decisions/0124-livedo-self-addressing-beta59-runtime-scope.md)). At the worker scope alchemy provides it ambiently; where the type doesn't reflect that (the stack program, unit tests), `RuntimeContext.phantom` erases the phantom requirement — see `alchemy.run.ts`.

## Where this leaves `env`

There is no `CloudflareEnv` service threading `env.PHOENIX_DB` into layers: native bindings are resolved by capability calls in init, and the resulting clients are passed into the services that need them. A capability service like `Drizzle` is built *from* the resolved raw handle, not from `env` — the `Database` seam (ADR 0040) resolves `Cloudflare.D1.QueryDatabase(PhoenixDb)` → `connection.raw` once in `DatabaseLive` (`worker/db/Database.ts`), and both Drizzle and the better-auth adapter derive from that one tag.

Genuinely env-shaped config (an `ENVIRONMENT` flag, a secret) rides the worker's `env` **prop** and is read back at runtime via `effect/Config` off the ConfigProvider alchemy auto-wires from the bound env — names single-sourced so the bind↔read seam can't drift. See [worker-environment-pattern.md](./worker-environment-pattern.md).

## See also

- [alchemy-worker.md](./alchemy-worker.md) — where the capability calls happen and binding layers are provided
- [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — `D1.QueryDatabase` → `raw` → Drizzle
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the DO class Tag as a binding
- [worker-environment-pattern.md](./worker-environment-pattern.md) — env vars: the `env` prop ↔ `effect/Config` seam
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — turning bound clients into worker-level services (the init-only runtime)
