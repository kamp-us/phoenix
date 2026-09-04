# @kampus/d1-rest

The single canonical **D1 REST transport**: `makeD1Rest`, a `D1Database`-shaped binding
backed by the Cloudflare D1 REST query API. It lets a plain Node process run drizzle
reads/writes against real D1 with no workerd, implementing only the slice `drizzle-orm/d1`
drives — `prepare` / `bind` / `all` / `run` / `raw` / `first` and `batch`.

## What it is

One module (`src/index.ts`, exported through the package root) holds every surface a
consumer touches:

- `makeD1Rest(config)` — build a `D1Database` over the REST API for a given
  `{accountId, databaseId, layer}`; `layer` provides `Credentials | HttpClient`. A single
  statement is one REST `/query` POST; a drizzle `batch([...])` collects every statement's
  sql+params into ONE REST batch call, which D1 runs as a single atomic transaction.
  `run()` carries D1's real row-change count into `meta.changes` (defaulting to 0);
  outside the drizzle-driven slice only inert stubs exist (`exec`, `dump`), so widening to
  the full binding type happens once, at the assembly point.
- `makeD1RestFromEnv(target)` / `d1RestLayerFromEnv` — the env-credentialed convenience
  (`$CLOUDFLARE_API_TOKEN` via `CredentialsFromEnv` + a Fetch client) a bin and its
  integration test both run the real direct-D1 work through.
- `resolveDatabaseName(config)` / `resolveDatabaseNameFromEnv(target)` — the `name`
  Cloudflare has recorded for a database id (`GET /accounts/{id}/d1/database/{id}`).
  The deploy stack writes that name and the caller cannot, which is what makes it usable
  as evidence about what a database *is* — `@kampus/preview-seed`'s throwaway fence keys
  on it (#7740). A record that comes back without a name throws rather than returning a
  value a fence would have to interpret.
- `readYourWrite(read, isConsistent, options?)` — a bounded read-your-writes poll for callers
  that need read-after-write consistency over this transport. The REST `/query` endpoint
  carries no D1 session bookmark (that Sessions API primitive is Workers-binding-only), so an
  immediate read after a write has no ordering guarantee; a caller that knows the post-write
  truth polls the read until it reflects it. Returns the last read either way — it waits out
  latency, it never masks a wrong read (#3075 / #3078).
- `toRestParams` / `assertRestParam` — the REST-wire param transform and its strict-`string[]`
  null guard (#569).
- `D1RestConfig` / `D1RestServices` / `ReadYourWriteOptions` types.

## Why it exists

Before it, three packages each hand-maintained their **own copy** of the same transport —
`packages/preview-seed/src/d1-rest.ts`, `packages/fts-backfill/src/d1-rest.ts`, and a
third in the since-deleted `moderator-grant`. Nothing coupled the copies, so a transport
bug had to be found and fixed **three times**: the latent `meta.changes` defect (`run()`
hardcoded `meta: {}`, dropping D1's row-change count) existed in triplicate and only bit
when a consumer finally read it — that package's `setRole`, which used the count to tell
a real flip (1) from a no-such-user miss (0) (issues #937 / #940). The copies had even
drifted incidentally — one rendered `null` params differently from the other two.

Now there is **one** transport. A transport fix is **one edit here**, reflected in every
consumer by construction. This is the same per-package-copy consolidation #859 did for the
Drizzle schema into `@kampus/db-schema`, under the same drift-guard thinking as #903 / #930.

### Why a leaf (the load-bearing constraint)

`@kampus/fts-backfill` **prod-depends on `@kampus/web`**, and the repo deliberately keeps
`apps/web → fts-backfill` **off** the dependency graph (it would be a cycle). So the shared
transport **cannot** depend on `@kampus/web` or anything that pulls it — it has to be a
**true leaf**, depending only on what the transport itself needs:
`@distilled.cloud/cloudflare` (the `queryDatabase` REST client, already in the tree via
alchemy) and `effect`. The three consumers then depend on this leaf, and the dep graph stays
acyclic.

Scope boundary: this package owns the transport only — no credential management beyond the
env layer above, no query building (drizzle owns that in each consumer), and no read-your-writes
guarantee in the wire itself (the REST endpoint accepts no session bookmark; ordering is the
caller's job through `readYourWrite`).

## How to use it

Point a bin or integration test at a real D1 over the env-credentialed layer (requires
`$CLOUDFLARE_API_TOKEN` in the environment):

```ts
import {makeD1RestFromEnv} from "@kampus/d1-rest";

const d1 = makeD1RestFromEnv({
	accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
	databaseId: "<stage-d1-uuid>",
});

const row = await d1.prepare("select id from user where email = ?").bind(email).first();
```

Or supply your own `Credentials | HttpClient` layer:

```ts
import {d1RestLayerFromEnv, makeD1Rest} from "@kampus/d1-rest";

const d1 = makeD1Rest({accountId, databaseId, layer: d1RestLayerFromEnv});
```

After a write whose read-back must already reflect it, poll instead of reading immediately:

```ts
import {readYourWrite} from "@kampus/d1-rest";

const user = await readYourWrite(
	() => findByEmail(db, email),
	(u) => u?.role === "yazar",
);
```

## Reference

Consumers (every workspace dependent today):

| Consumer                 | Runs over this transport                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| `@kampus/preview-seed`   | `seed(d1)` (bin + integration tier)                                              |
| `@kampus/fts-backfill`   | the FTS5 re-index batch; its bin uses `makeD1RestFromEnv`                         |
| `@kampus/founder-seed`   | its bin builds the transport with `makeD1Rest`                                    |
| `@kampus/admin-grant`    | `grant` / `revoke` / `list` writes; its bin uses `makeD1Rest`                     |
| `apps/web`               | integration tests drive real D1 through `makeD1Rest` and order reads with `readYourWrite` |

`readYourWrite` options (all optional):

| Option         | Default            | Meaning                                                       |
| -------------- | ------------------ | ------------------------------------------------------------- |
| `maxAttempts`  | `6`                | max poll attempts, counting the first read                    |
| `baseDelayMs`  | `100`              | base of the exponential backoff, in ms                        |
| `sleep`        | real `setTimeout`  | injected for tests                                            |

Wire contract: bound params travel as a strict `string[]`; a `null`/`undefined` element
rejects (#569) — render SQL NULL inline by leaving the nullable column unset so drizzle
emits a literal `NULL`, never a bound `null`.

## Tests

The transport's contract is tested **once**, in `src/index.unit.test.ts` (no CF creds, no SQL
engine — ADR 0082 unit tier): the `meta.changes` mapping (carried + defaulting to 0), the
`toRestParams` null rejection (#569), the batch single-POST contract, and `readYourWrite`'s
read-your-writes poll (re-reads until consistent; returns the last value on exhaustion so a real
absence is never masked). Each consumer's integration tier still exercises the real transport
against real D1 end to end.

```bash
pnpm --filter @kampus/d1-rest test       # the unit tier — offline, fake Fetch
pnpm --filter @kampus/d1-rest typecheck
```
