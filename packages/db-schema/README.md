# @kampus/db-schema

The single canonical Drizzle declaration of the D1 **read-model tables that more than one
package reads**: `term_summary`, `definition_record`, `post_summary`, `comment_record`.

## Why this package exists

Before it, three packages each hand-maintained their own Drizzle mirror of these same tables —
`apps/web/worker/db/drizzle/schema.ts`, `packages/preview-seed/src/schema.ts`, and
`packages/fts-backfill/src/schema.ts` — pinned only by a "mirror the canonical migration"
docblock. Nothing coupled the declarations, so a column change drifted **silently**: ADR 0093's
`is_draft` never reached the preview-seed copy, and ADR 0096's `deleted_at → removed_at` rename
(PR #894) broke the two copies — caught only by real-D1 CI at deploy/runtime, the most expensive
place (issues #859 / #903).

Now there is **one** declaration. A column rename is **one edit here**, reflected in every
consumer by construction and caught by `pnpm typecheck` — not by a runtime D1 error.

## Why a leaf (and not "import the worker schema directly")

`@kampus/fts-backfill` already prod-depends on `@kampus/web`, and the repo deliberately keeps
`apps/web → fts-backfill` **off** the dependency graph (it would be a cycle). So the shared
source can't be the worker schema imported directly — it has to be a **leaf** that depends only
on `drizzle-orm`, which the worker and both CLI packages then depend on. Adding `@kampus/web →
@kampus/db-schema` and `@kampus/{preview-seed,fts-backfill} → @kampus/db-schema` keeps the graph
acyclic: the leaf depends on nothing internal.

## Scope — what is and isn't here

**Here:** only the *shared* read-model tables (the four above), with their full canonical column
set and indexes.

**Not here:**
- **Worker-only tables** — the better-auth tables, the vote/bookmark presence rows, the stats
  singletons, `user_profile`, `content_report`. No package duplicates them, so they stay in
  `apps/web/worker/db/drizzle/schema.ts`, which re-exports this package's tables alongside them.
- **The FTS5 virtual tables** (`term_search` / `post_search`, ADR 0080). The worker never models
  them as Drizzle tables (they're raw-`sql`-synced; drizzle-kit can't emit `CREATE VIRTUAL
  TABLE`), and `drizzle.config.ts` reads the worker schema graph for migration generation —
  declaring them here would make drizzle-kit try to migrate a table the FTS migration owns.
  `preview-seed` keeps its own plain-`sqliteTable` model of them locally (it's a seed-write
  convenience, not duplicated canonical knowledge).

## Consumers

- `apps/web/worker/db/drizzle/schema.ts` — re-exports `termSummary` / `definitionRecord` /
  `postSummary` / `commentRecord` from here, keeps the worker-only tables local. The 15 worker
  import sites still import from `db/drizzle/schema` unchanged.
- `packages/preview-seed/src/schema.ts` — re-exports these four, adds its local FTS-table models.
- `packages/fts-backfill/src/schema.ts` — re-exports `termSummary` / `postSummary` (it reads only
  a projection of their columns).
