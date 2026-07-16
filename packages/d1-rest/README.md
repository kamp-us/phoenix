# @kampus/d1-rest

The single canonical **D1 REST transport**: `makeD1Rest`, a `D1Database`-shaped binding
backed by the Cloudflare D1 REST query API. It lets a plain Node process run drizzle
reads/writes against real D1 with no workerd, implementing only the slice `drizzle-orm/d1`
drives — `prepare` / `bind` / `all` / `run` / `raw` / `first` and `batch`.

## Why this package exists

Before it, three packages each hand-maintained their **own copy** of the same transport —
`packages/preview-seed/src/d1-rest.ts`, `packages/fts-backfill/src/d1-rest.ts`, and
`packages/moderator-grant/src/d1-rest.ts`. Nothing coupled the copies, so a transport bug
had to be found and fixed **three times**: the latent `meta.changes` defect (`run()`
hardcoded `meta: {}`, dropping D1's row-change count) existed in triplicate and only bit
when a consumer finally read it — moderator-grant's `setRole`, which uses the count to tell
a real flip (1) from a no-such-user miss (0) (issues #937 / #940). The copies had even
drifted incidentally — one rendered `null` params differently from the other two.

Now there is **one** transport. A transport fix is **one edit here**, reflected in every
consumer by construction. This is the same per-package-copy consolidation #859 did for the
Drizzle schema into `@kampus/db-schema`, under the same drift-guard thinking as #903 / #930.

## Why a leaf (the load-bearing constraint)

`@kampus/fts-backfill` **prod-depends on `@kampus/web`**, and the repo deliberately keeps
`apps/web → fts-backfill` **off** the dependency graph (it would be a cycle). So the shared
transport **cannot** depend on `@kampus/web` or anything that pulls it — it has to be a
**true leaf**, depending only on what the transport itself needs:
`@distilled.cloud/cloudflare` (the `queryDatabase` REST client, already in the tree via
alchemy) and `effect`. The three consumers then depend on this leaf, and the dep graph stays
acyclic.

## API

- `makeD1Rest(config)` — build a `D1Database` over the REST API for a given
  `{accountId, databaseId, layer}`; `layer` provides `Credentials | HttpClient`.
- `makeD1RestFromEnv(target)` / `d1RestLayerFromEnv` — the env-credentialed convenience
  (`$CLOUDFLARE_API_TOKEN` via `CredentialsFromEnv` + a Fetch client) a bin and its
  integration test both run the real direct-D1 work through.
- `toRestParams` / `assertRestParam` — the REST-wire param transform and its strict-`string[]`
  null guard (#569).
- `readYourWrite(read, isConsistent, options?)` — a bounded read-your-writes poll for callers that
  need read-after-write consistency over this transport. The REST `/query` endpoint carries no D1
  session bookmark (that Sessions API primitive is Workers-binding-only), so an immediate read after
  a write has no ordering guarantee; a caller that knows the post-write truth polls the read until it
  reflects it. Returns the last read either way — it waits out latency, it never masks a wrong read
  (#3075 / #3078).
- `D1RestConfig` / `D1RestServices` / `ReadYourWriteOptions` types.

## Consumers

- `@kampus/preview-seed` — runs `seed(d1)` over this transport (bin + integration tier).
- `@kampus/fts-backfill` — runs the FTS5 re-index batch over it; its bin uses
  `makeD1RestFromEnv`.
- `@kampus/moderator-grant` — runs `setRole` / `listModerators` over it; relies on the
  `meta.changes` mapping carried here.

## Tests

The transport's contract is tested **once**, in `src/index.unit.test.ts` (no CF creds, no SQL
engine — ADR 0082 unit tier): the `meta.changes` mapping (carried + defaulting to 0), the
`toRestParams` null rejection (#569), the batch single-POST contract, and `readYourWrite`'s
read-your-writes poll (re-reads until consistent; returns the last value on exhaustion so a real
absence is never masked). Each consumer's integration tier still exercises the real transport
against real D1 end to end.
