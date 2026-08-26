# @kampus/db-schema

The single canonical Drizzle declaration of the D1 read-model tables that more than one
package reads: `term_record`, `definition_record`, `post_record`, `comment_record`.

## What it is

One module, four exports. `src/index.ts` is the package's only entry (`exports["."]`), and it
declares:

- `termRecord` — the sözlük term index: letter pivot (`first_letter`), score/activity columns,
  and the `excerpt` of the top definition.
- `definitionRecord` — definitions, denormalized with term slug + title so the profile feed
  renders without a join.
- `postRecord` — pano posts, including the HN-style `hot_score` and the draft (taslak) marker
  `is_draft` (ADR 0093).
- `commentRecord` — comments, denormalized with post id + title for the profile feed and the
  per-post thread reader.

All four are authoritative mutated stores of record (D1-direct, ADR 0009). The `_record` suffix
marks a **cross-package, shared** store of record specifically (#1139) — worker-private stores
(`user_profile`, `content_report`, the stats singletons) are equally authoritative but live in
the worker schema without the suffix, because no other package duplicates them.

Two nullable-timestamp column families ride every content table (`definition_record`,
`post_record`, `comment_record`), on one lifecycle substrate:

- **The ADR 0096 removal triad** — `removed_at` / `removed_by` / `removed_reason`. `removed_at`
  null ⇒ live; the column is the former `deleted_at`, repurposed.
- **The çaylak sandbox marker** (#1205) — `sandboxed_at`, null ⇒ not sandboxed; a çaylak's new
  content is visible to its author and moderators only until promotion. Each content table
  carries a `*_sandboxed` index for the moderator queue / promotion backlog (#1206).

Both are projected to `EntityLifecycle` in the worker — services never read these columns raw,
and the closed union makes sandboxed-AND-removed unrepresentable.

## Why it exists

Before it, three packages each hand-maintained their own Drizzle mirror of these same tables —
the worker's `db/drizzle/schema.ts`, `packages/preview-seed/src/schema.ts`, and
`packages/fts-backfill/src/schema.ts` — pinned only by a "mirror the canonical migration"
docblock. Nothing coupled the declarations, so a column change drifted **silently**: ADR 0093's
`is_draft` never reached the preview-seed copy, and ADR 0096's `deleted_at → removed_at` rename
(PR #894) broke the two copies — caught only by real-D1 CI at deploy/runtime, the most expensive
place (issues #859 / #903).

Now there is **one** declaration. A column rename is **one edit here**, reflected in every
consumer by construction and caught by `pnpm typecheck` — not by a runtime D1 error.

**Why a leaf, and not "import the worker schema directly":** `@kampus/fts-backfill` already
prod-depends on `@kampus/web`, and the repo deliberately keeps `apps/web → fts-backfill` **off**
the dependency graph (it would be a cycle). So the shared source has to be a **leaf** that
depends only on `drizzle-orm`, which the worker and both CLI packages then depend on — the leaf
depends on nothing internal, and the graph stays acyclic.

### Scope — what is and isn't here

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
  `preview-seed` keeps its own plain-`sqliteTable` model of them locally (a seed-write
  convenience, not duplicated canonical knowledge).

## How to use it

Depend on it and import the tables — there is no config, no CLI, no build step:

```ts
import {commentRecord, definitionRecord, postRecord, termRecord} from "@kampus/db-schema";
```

A schema change is an edit to `src/index.ts` here, plus the matching D1 migration in the worker
(`drizzle.config.ts` there reads this package's tables through the worker schema graph). Every
consumer picks the change up by construction.

## Consumers

- `apps/web/worker/db/drizzle/schema.ts` — re-exports all four tables from here, keeps the
  worker-only tables local; worker code keeps importing from `db/drizzle/schema` unchanged.
- `packages/preview-seed/src/schema.ts` — re-exports `termRecord` / `definitionRecord` /
  `postRecord`, adds its local FTS-table models.
- `packages/fts-backfill/src/schema.ts` — re-exports `termRecord` / `postRecord` (it reads only
  a projection of their columns).

## Testing

```bash
pnpm --filter @kampus/db-schema test
```

One vitest suite, `src/index.unit.test.ts`: a column-set anchor that pins each table's exact
column set, so a column added or renamed here fails the test unless it is updated alongside.
The two columns that historically failed to propagate to the hand-copies — `is_draft` and the
`removed_at` triad — are asserted explicitly.
