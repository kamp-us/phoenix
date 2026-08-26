# @kampus/db-schema

The single canonical Drizzle declaration of the D1 **read-model tables that more than one
package reads** — `term_record`, `definition_record`, `post_record`, `comment_record` — the one
source the worker, `preview-seed`, and `fts-backfill` all import, so a column rename is **one
edit here**.

## What it is

One module, [`src/index.ts`](./src/index.ts), exporting four Drizzle `sqliteTable` declarations —
the shared stores of record, each with its full canonical column set and indexes:

- **`termRecord`** (`term_record`) — per-term read model: slug key, denormalized title /
  first letter / excerpt / top-definition pointer, activity timestamps; recent / popular /
  letter indexes.
- **`definitionRecord`** (`definition_record`) — per-definition rows denormalized with term slug +
  title so the profile feed renders without joining `term_record`; author+created, term+score,
  and sandboxed indexes.
- **`postRecord`** (`post_record`) — Pano posts with denormalized author, host, tags and hot
  score; hot / new / top / discuss / host indexes, a newest-first author-feed index (per-column
  ordering via a `sql` fragment), and a partial unique index
  (`post_record_one_draft_per_author`) enforcing one draft per author.
- **`commentRecord`** (`comment_record`) — per-comment rows denormalized with post id + title for
  the profile feed and the per-post thread reader; author+created, post, parent, and sandboxed
  indexes.

The exported names carry the `_record` suffix, which marks a **cross-package / shared store of
record** specifically — not "every mutated store of record": worker-private authoritative stores
(`user_profile`, `content_report`, the stats singletons) live in the worker schema without the
suffix because no other package duplicates them (#1139).

Three lifecycle column groups are load-bearing across every consumer:

| Column group | Tables | Meaning |
| --- | --- | --- |
| `removed_at` / `removed_by` / `removed_reason` ([ADR 0096](../../.decisions/0096-uniform-soft-delete-substrate.md)) | definition, post, comment | soft removal; `removed_at` null ⇒ Live. Projected to `EntityLifecycle` — services never read these raw. |
| `sandboxed_at` (#1205) | definition, post, comment | çaylak mod-only sandbox marker on the same ADR 0096 substrate; null ⇒ not sandboxed. A çaylak's new content is stamped sandboxed (visible to author + moderators) until promotion (#1206). Projected to `EntityLifecycle.Sandboxed`, so sandboxed-AND-removed is unrepresentable. |
| `is_draft` ([ADR 0093](../../.decisions/0093-pano-draft-save-flag-consumer.md)) | post | nullable draft marker; null ⇒ published. One draft per author, enforced by the partial unique index above. |

## Why it exists

Before this leaf, three packages each hand-maintained their own Drizzle mirror of these same
tables — `apps/web/worker/db/drizzle/schema.ts`, `packages/preview-seed/src/schema.ts`, and
`packages/fts-backfill/src/schema.ts` — pinned only by a "mirror the canonical migration"
docblock. Nothing coupled the declarations, so a column change drifted **silently**: ADR 0093's
`is_draft` never reached the preview-seed copy, and [ADR 0096](../../.decisions/0096-uniform-soft-delete-substrate.md)'s
`deleted_at → removed_at` rename broke two of them — caught only by real-D1 CI at deploy/runtime,
the most expensive place (#859 / #903). Now there is **one** declaration under D1-direct
([ADR 0009](../../.decisions/0009-d1-direct-defer-dos-and-workflows.md)): a column rename here is
reflected in every consumer by construction and caught by `pnpm typecheck` — not by a runtime D1
error.

### Why a leaf (and not "import the worker schema directly")

`@kampus/fts-backfill` already prod-depends on `@kampus/web`, and the repo deliberately keeps
`apps/web → fts-backfill` **off** the dependency graph (it would be a cycle). So the shared source
can't be the worker schema imported directly — it has to be a **leaf** that depends only on
`drizzle-orm`. Adding `@kampus/web → @kampus/db-schema` and
`@kampus/{preview-seed,fts-backfill} → @kampus/db-schema` keeps the graph acyclic: the leaf
depends on nothing internal.

### Scope — what is and isn't here

**Here:** only the *shared* read-model tables (the four above), with their full canonical column
set and indexes.

**Not here:**

- **Worker-only tables** — the better-auth tables, the vote/bookmark presence rows, the stats
  singletons, `user_profile`, `content_report`. No package duplicates them, so they stay in
  `apps/web/worker/db/drizzle/schema.ts`, which re-exports this package's tables alongside them.
- **The FTS5 virtual tables** (`term_search` / `post_search`,
  [ADR 0080](../../.decisions/0080-site-search-lexical-bar-semantic-discovery.md)). The worker
  never models them as Drizzle tables (they're raw-`sql`-synced; drizzle-kit can't emit
  `CREATE VIRTUAL TABLE`), and `drizzle.config.ts` reads the worker schema graph for migration
  generation — declaring them here would make drizzle-kit try to migrate a table the FTS migration
  owns. `preview-seed` keeps its own plain-`sqliteTable` model of them locally (a seed-write
  convenience, not duplicated canonical knowledge).

### Consumers

- `apps/web/worker/db/drizzle/schema.ts` — re-exports `termRecord` / `definitionRecord` /
  `postRecord` / `commentRecord` from here and keeps the worker-only tables local, so worker
  feature modules keep importing from `db/drizzle/schema` unchanged.
- `packages/preview-seed/src/schema.ts` — re-exports `termRecord` / `definitionRecord` /
  `postRecord` (it seeds those three), plus its local FTS-table models.
- `packages/fts-backfill/src/schema.ts` — re-exports `termRecord` / `postRecord` (it reads only a
  projection of their columns).

## How to use it

Depend on it via `workspace:*` and import the tables you read:

```ts
import {commentRecord, definitionRecord, postRecord, termRecord} from "@kampus/db-schema";
```

Never re-declare these tables locally: a local copy is exactly the drift class this leaf closes.

Package scripts (run from the repo root with `pnpm --filter @kampus/db-schema …`):

```bash
pnpm --filter @kampus/db-schema typecheck   # tsc -p tsconfig.json
pnpm --filter @kampus/db-schema test        # vitest run
```

## Testing

```bash
pnpm --filter @kampus/db-schema test        # vitest run
```

The suite in [`src/index.unit.test.ts`](./src/index.unit.test.ts) pins the exact column set of
each shared table — the regression guard for the drift class above. The columns that silently
failed to propagate to the old copies (`is_draft`, the `removed_at` triad, `sandboxed_at`) are
asserted explicitly, so a column change without a matching test update fails here first.
