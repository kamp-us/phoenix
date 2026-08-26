# @kampus/fts-backfill

Direct-D1 **FTS index rebuild** — re-derives the `term_search` / `post_search`
FTS5 index from the base `term_record` / `post_record` rows ([ADR
0080](../../.decisions/0080-site-search-lexical-bar-semantic-discovery.md)).
Two callers, one command (`fts-backfill run`): the one-time backfill of
pre-dual-write content (#534), and the standing rebuild the D1 export/restore
runbook depends on (#2754 / #2703). Both are the same operation — the FTS index
is fully derived from the base tables, so rebuilding it is always "replay the
dual-write over every base row".

## What it is

A pure, unit-tested core plus a thin Effect CLI bin (the repo tooling idiom):

- `src/schema.ts` — the read-side slice (key + title) of the two summary
  tables, imported from the canonical [`@kampus/db-schema`](../db-schema/) leaf
  so this copy cannot drift from the real schema (the `deleted_at →
  removed_at` rename that broke an earlier hand-copy now arrives by
  construction).
- `src/backfill.ts` — `buildBackfillStatements` (pure: source rows → FTS upsert
  SQL via the worker's sync builders), `backfill(d1)` (reads rows, runs the
  atomic batch), and `makeBackfillDb`.
- `src/bin.ts` — the `fts-backfill run` CLI (`effect/unstable/cli`). Its
  `D1Database` transport is the shared `@kampus/d1-rest` REST adapter (the same
  one [`@kampus/preview-seed`](../preview-seed/) uses).
- `src/index.ts` — the public exports: `backfill`, `buildBackfillStatements`,
  `makeBackfillDb`, `backfillSchema`, plus the `BackfillDb`, `BackfillReport`,
  `SourceRow` and `BackfillSchema` types and the `@kampus/d1-rest` transport
  re-exports (`makeD1RestFromEnv` and friends).

It **reuses the worker's own** `syncTermSearch` / `syncPostSearch`
(`@kampus/web/features/search/fts-sync`) — not a reimplementation — so the
indexed `norm` is byte-identical to the dual-write's. The unit test pins the
two against drift.

## Why it exists

The FTS5 search tables `term_search` / `post_search` (ADR
[0080](../../.decisions/0080-site-search-lexical-bar-semantic-discovery.md))
are populated **only by the application dual-write on new writes**
(`syncTermSearch` / `syncPostSearch`, called from the sözlük/pano mutation
handlers). Rows written **before** that sync existed in `term_record` /
`post_record` but were never indexed — so search returns **empty for all
pre-existing content** until each row is organically re-touched. The migration
`0002_search_fts.sql` is DDL-only; it creates the virtual tables but never
backfills them. This package replays the dual-write over every existing source
row, once.

### Scope boundary — why a package, not a migration

A `.sql` migration cannot produce a correct FTS row: the indexed `norm` column
is the **app-side Turkish fold** (`normalizeSearchText` — Turkish-correct
casing + ç/ş/ğ/ö/ü/ı diacritic fold), applied symmetrically at write and query
time (ADR 0080). A migration would have to re-spell that fold in raw SQL using
exactly the `unicode61` ASCII-wrong `I→i` case-folding ADR 0080 rejects —
backfilled rows wouldn't match queries. And a migration runs on **every**
deploy to **every** stage; this is a **one-time data operation**, not a schema
change — nothing here lands in `migrations/`, and no runtime seeder route may
be rebuilt either (CLAUDE.md's "Sözlük seed" section). So this is a direct-D1
script against the bound database — Node tooling mirroring
[`@kampus/preview-seed`](../preview-seed/) /
[`@kampus/migrations-guard`](../migrations-guard/), not a worker route, not
Python.

## How to use it

One-time backfill of an environment whose data predates the FTS migration
(production after the search rollout; any preview/staging migrated onto the FTS
tables):

```bash
node packages/fts-backfill/src/bin.ts run --database-id <stage-d1-uuid>
# → fts-backfill: ok — re-indexed <N> term(s), <M> post(s) into term_search/post_search
#   on D1 <uuid> (idempotent upsert)
```

Run **once per environment**. New writes stay current automatically via the
dual-write; only rows older than the sync need the replay. The command needs
live Cloudflare credentials (see [Reference](#reference)) and targets the named
stage's D1 over the REST query API — it is never prod-hardcoded.

### As the D1-restore FTS rebuild (restore step-3)

D1 cannot export a database that contains virtual tables (ADR 0080), so the
export/restore runbook ([#2703]) exports the base tables only and skips
`term_search` / `post_search`; a restore therefore lands with the base rows
intact but the FTS index **empty** (the virtual tables recreated bare by the
migration). `fts-backfill run` **is** that runbook's restore step-3 — the
same command against the restored D1 reconstructs the whole index from the
restored base rows, deriving `norm` through the real `normalizeSearchText`
fold (never a raw-SQL re-spelling):

```bash
node packages/fts-backfill/src/bin.ts run --database-id <restored-stage-d1-uuid>
```

The restore-scenario proof — both FTS tables wiped, then one run reconstructs
the full index with correct row counts + exact and prefix `MATCH` on real D1 —
lives in
[`apps/web/tests/integration/fts-backfill-restore.test.ts`](../../apps/web/tests/integration/fts-backfill-restore.test.ts)
(#2754).

## Reference

### Flags & environment

| Input | Required | Meaning |
| --- | --- | --- |
| `--database-id` | yes | the target stage's D1 database UUID to backfill (resolve from the alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`) |
| `--account-id` | no | Cloudflare account id; defaults to `$CLOUDFLARE_ACCOUNT_ID` |
| `$CLOUDFLARE_API_TOKEN` | env | a token carrying `D1 Write`; read by `CredentialsFromEnv` |

A rejected D1 REST call exits non-zero with a typed `D1RestError`; success
prints the indexed row counts shown above.

### Idempotency

Each sync builder is a `DELETE … WHERE key = ?` then `INSERT …` — keyed on
slug/id. The whole set lands as one atomic D1 `batch`. Re-running replaces the
same FTS rows rather than duplicating them, so the backfill is **safe to
re-run**: on a freshly-restored D1 whose FTS tables are already empty, and if a
rebuild is interrupted. Removed posts (`removed_at IS NOT NULL`) are skipped —
the resolver only hydrates live posts, and the dual-write removes a removed
post's FTS row. An empty corpus is a clean no-op (D1 `batch` rejects an empty
tuple, so the empty case returns without a write).

## Testing

```bash
pnpm --filter @kampus/fts-backfill test        # vitest unit tier
pnpm --filter @kampus/fts-backfill typecheck   # tsc
```

The unit tests assert the statement set through the pure
`buildBackfillStatements` with fixtures — no database. The real-D1 restore
proof is the integration test linked under *How to use it*.

[#2703]: https://github.com/kamp-us/phoenix/issues/2703
