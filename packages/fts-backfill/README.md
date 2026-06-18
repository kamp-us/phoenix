# @kampus/fts-backfill

One-time, direct-D1 **FTS backfill** — re-index existing sözlük/pano content for
search (issue #534).

## Why

The FTS5 search tables `term_search` / `post_search` (ADR
[0080](../../.decisions/0080-site-search-lexical-bar-semantic-discovery.md)) are
populated **only by the application dual-write on new writes** (`syncTermSearch` /
`syncPostSearch`, called from the sözlük/pano mutation handlers). Rows written
**before** that sync existed in `term_summary` / `post_summary` but were never
indexed — so search returns **empty for all pre-existing content** until each row
is organically re-touched. The migration `0002_search_fts.sql` is DDL-only; it
creates the virtual tables but never backfills them.

This backfill replays the dual-write over every existing source row, once.

## Why a package, not a migration

A `.sql` migration cannot produce a correct FTS row: the indexed `norm` column is
the **app-side Turkish fold** (`normalizeSearchText` — Turkish-correct casing +
ç/ş/ğ/ö/ü/ı diacritic fold), applied symmetrically at write and query time (ADR
0080). A migration would have to re-spell that fold in raw SQL using exactly the
`unicode61` ASCII-wrong `I→i` case-folding ADR 0080 rejects — backfilled rows
wouldn't match queries. And a migration runs on **every** deploy to **every**
stage; this is a **one-time data operation**, not a schema change.

So per CLAUDE.md's "Sözlük seed" section, this is a **direct-D1 script against the
bound database** — Node tooling (an `effect/unstable/cli` Effect CLI, mirroring
`@kampus/preview-seed` / `@kampus/leak-guard`), not a worker route, not Python.

It **reuses the worker's own** `syncTermSearch` / `syncPostSearch`
(`@kampus/web/features/search/fts-sync`) — not a reimplementation — so the indexed
`norm` is byte-identical to the dual-write's. The unit test pins the two against
drift.

## Idempotency

Each sync builder is a `DELETE … WHERE key = ?` then `INSERT …` — keyed on
slug/id. The whole set lands as one atomic D1 `batch`. Re-running replaces the
same FTS rows rather than duplicating them, so the backfill is **safe to re-run**.
Deleted posts (`deleted_at IS NOT NULL`) are skipped — the resolver only hydrates
live posts, and the dual-write removes a deleted post's FTS row.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/schema.ts` — the read-side slice (key + title) of the two summary tables.
- `src/backfill.ts` — `buildBackfillStatements` (pure: source rows → FTS upsert
  SQL via the worker's sync builders) + `backfill(d1)` (reads rows, runs the
  atomic batch).
- `src/d1-rest.ts` — a `D1Database` over the Cloudflare D1 REST API (same adapter
  as `@kampus/preview-seed`).
- `src/bin.ts` — the `fts-backfill run` CLI.

## Running it against a real D1

Targets a **named stage's D1** (never prod-hardcoded):

```bash
node packages/fts-backfill/src/bin.ts run --database-id <stage-d1-uuid>
```

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — a token carrying `D1 Write`; read by
  `CredentialsFromEnv`.

Run **once per environment** whose data predates the FTS migration (production
after the search rollout; any preview/staging migrated onto the FTS tables). New
writes stay current automatically via the dual-write.
