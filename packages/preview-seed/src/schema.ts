/**
 * The slice of the phoenix D1 schema this seed writes. The read-model tables
 * (`term_summary` / `definition_record` / `post_summary`) come from the
 * `@kampus/db-schema` leaf — the single canonical declaration the worker also
 * re-exports — so this seed can no longer drift from the real schema (issue
 * #859: the `is_draft`/`removed_at` columns now arrive by construction, not by
 * hand-copy). The leaf is a true leaf (only `drizzle-orm`), so depending on it
 * adds no cycle even though this package already prod-depends on `@kampus/web`.
 *
 * Only the FTS5 search tables are modeled locally (below) — they're a seed-write
 * convenience, not duplicated canonical knowledge (the worker doesn't model them
 * as drizzle tables either).
 */
import {definitionRecord, postSummary, termSummary} from "@kampus/db-schema";
import {sqliteTable, text} from "drizzle-orm/sqlite-core";

export {definitionRecord, postSummary, termSummary};

/**
 * The FTS5 search tables (`term_search` / `post_search`, ADR 0080), modeled as
 * plain drizzle tables over their two columns. The migration declares them as
 * `CREATE VIRTUAL TABLE … USING fts5(…)`; drizzle-kit can't express that, so they
 * are NOT in the canonical `@kampus/db-schema` leaf. The seed only needs to
 * delete+insert two columns, which a plain `sqliteTable` maps cleanly. Modeled
 * here (rather than reusing the worker's raw-`sql` `syncTermSearch` builders) so
 * the seed's FTS writes are real drizzle `insert`/`delete` builders —
 * batch-compatible (`SQLiteRaw` from `db.run(sql)` has no `.stmt`, so it can't
 * ride the D1 `batch`). The indexed `norm` is still the worker's OWN
 * `normalizeSearchText` (imported in seed.ts), so the value is byte-identical to
 * the dual-write's.
 */
export const termSearch = sqliteTable("term_search", {
	slug: text("slug").notNull(),
	norm: text("norm").notNull(),
});

export const postSearch = sqliteTable("post_search", {
	id: text("id").notNull(),
	norm: text("norm").notNull(),
});

export const seedSchema = {termSummary, definitionRecord, postSummary, termSearch, postSearch};
export type SeedSchema = typeof seedSchema;
