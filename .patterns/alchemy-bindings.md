# Bindings

How phoenix reaches Cloudflare resources. The short answer: `bind()` is one line that does three jobs — at **deploy time** it records the binding's metadata for the Cloudflare API; at **runtime** it resolves a typed, Effect-wrapped client. You `yield*` it in the worker's init phase and use the result in handlers. There is no `env.PHOENIX_DB`.

## Two phases, one call

Every binding has two halves under the hood:

- a **deploy-time Policy** — records `{type, name, …}` so alchemy sends the right binding to the Cloudflare API. A no-op at runtime.
- a **runtime Service** — yields the typed client wrapping the live binding.

`bind()` is the seam that runs the right half in the right phase. You write it once; the same expression contributes the binding at deploy and the client at runtime. This is why infra and app code can share one program.

## Two binding shapes

phoenix sees two forms. They differ by whether the resource *is* a service.

**`yield* Cloudflare.X.bind(resource)`** — for D1, R2, KV, Hyperdrive, AI Gateway, Queues. The resource is a value; `.bind` resolves the client:

```ts
const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);
// db: D1ConnectionClient — prepare/exec/batch/raw, all Effect-returning
```

**`yield* SomeDurableObject`** — for Durable Objects. The DO namespace *is* the resource and the binding; yielding it gives the typed stub factory:

```ts
const topics = yield* TopicDO;
const stub = topics.getByName("topic:pano:posts");
yield* stub.publish(frame);            // typed RPC
```

See [alchemy-durable-objects.md](./alchemy-durable-objects.md) for the DO side and [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) for D1.

## The Live-layer convention

`Cloudflare.X.bind` needs the matching binding **service** in scope. Provide its `…Live` layer onto the worker body:

```ts
Effect.gen(function* () {
  const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);
  // …
}).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive)))
```

The naming is mechanical: `D1Connection` → `D1ConnectionLive`, `R2Bucket` → `R2BucketBindingLive`, `KVNamespace` → `KVNamespaceBindingLive`. If you add a binding and forget its Live layer, the worker body fails to type-check — the binding service shows up unsatisfied in the Effect's `R` channel.

> **Durable Objects don't take a Live layer.** `yield* TopicDO` resolves the namespace directly; there is no `TopicDOLive` to provide. Only the `.bind`-style bindings have a separate runtime service.

## phoenix's bindings

| Resource | Declaration | Bound as | Backed by |
|---|---|---|---|
| `PhoenixDb` | `Cloudflare.D1Database("phoenix_db")` | `Cloudflare.D1Connection.bind(PhoenixDb)` | `Cloudflare.D1ConnectionLive` |
| `ConnectionDO` | `Cloudflare.DurableObjectNamespace<…>()(…)` | `yield* ConnectionDO` | — |
| `TopicDO` | `Cloudflare.DurableObjectNamespace<…>()(…)` | `yield* TopicDO` | — |

R2/KV are not used yet; when they appear, declare the resource in the stack, `bind()` it in init, and add its `…Live` layer.

## The clients are Effect-native

Bound clients return Effects, not promises — they compose into service methods directly, with the binding's failures as typed errors:

```ts
const obj = yield* bucket.get(key);            // Effect<R2Object | null, R2Error>
yield* kv.put(key, value);                     // Effect<void, …>
const rows = yield* db.prepare(sql).bind(id).all<Row>();  // Effect<…>
```

For D1 specifically, prepared-statement construction (`prepare`, `bind`) is synchronous (plan-building); only `all`/`first`/`run`/`raw`/`batch` round-trip. The `raw` escape hatch returns the underlying Cloudflare binding for libraries that want it (Drizzle, better-auth) — see [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md).

## Where this leaves `CloudflareEnv`

Today phoenix threads a `CloudflareEnv` service so layers can read `env.PHOENIX_DB`. On alchemy that service largely recedes: bindings are resolved by `bind()` in init, and the resulting clients are passed into the services that need them. A capability service like `Drizzle` is built *from* the bound `db`, not from `env` — see [alchemy-runtime.md](./alchemy-runtime.md). Any genuinely env-shaped config (e.g. an `ENVIRONMENT` flag) becomes a plain resource var or a small `Layer.succeed`.

It doesn't vanish entirely, though. A few consumers still need the underlying raw `D1Database` — better-auth's Drizzle adapter most notably — and that now comes from the bound connection's `raw` rather than `env.PHOENIX_DB`. Note `raw` is itself an Effect (`Effect<D1Database, never, …>`), so you obtain it with `const raw = yield* conn.raw` in the same init phase, then thread it where it's needed.

## See also

- [alchemy-worker.md](./alchemy-worker.md) — where `bind()` is called and Live layers are provided
- [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — `D1Connection.bind` → `raw` → Drizzle
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the DO namespace as a binding
- [alchemy-runtime.md](./alchemy-runtime.md) — turning bound clients into worker-level services
