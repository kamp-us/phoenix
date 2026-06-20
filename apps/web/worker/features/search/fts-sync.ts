/**
 * Dual-write FTS sync (ADR 0080). The FTS5 virtual tables `term_search` /
 * `post_search` are kept in lockstep with `term_summary` / `post_summary` from
 * the application write path — NOT D1 triggers — so the worker that owns every
 * write to a summary row writes its search row in the same place.
 *
 * Each sync is a delete-then-insert upsert (FTS5 has no `ON CONFLICT`, so a
 * re-sync removes the old row by key first). The module stays shallow (ADR 0080):
 * it builds statements and never crosses a service boundary — the caller spreads
 * the returned items, alongside the summary write, into ONE `Drizzle.batch` so the
 * summary row and its FTS row move all-or-none (the lockstep invariant ADR 0080
 * stakes the design on; a crash between the two can never desync them).
 *
 * Why drizzle query builders and NOT `sql`/`db.run(sql)`: a `Drizzle.batch` item
 * must `_prepare()` to a `D1PreparedQuery` carrying a bound `.stmt` — D1's batch
 * driver does `preparedQuery.stmt.bind(...params)` for every statement that has
 * params. `db.run(sql\`…\`)` yields a `SQLiteRaw`, whose `_prepare()` returns
 * itself with NO `.stmt`, so a parametrized raw statement throws
 * `undefined.bind` and 500s the whole write the moment it rides in a batch (#863
 * regression). A `db.insert(...)/.delete(...)` builder prepares to a real
 * `D1PreparedQuery`, so it is batch-safe. The FTS5 tables can't be drizzle-kit
 * generated (no virtual-table DSL — see `migrations/0002_search_fts.sql`), so we
 * declare minimal `sqliteTable` shims here purely to build batch-safe statements;
 * they are statement shapes, not a migration source.
 *
 * The indexed `norm` column is the Turkish-normalized title (see `normalize.ts`);
 * the `slug`/`id` column is `UNINDEXED`, carried only to join the match back to
 * the summary row.
 */

import {eq} from "drizzle-orm";
import {sqliteTable, text} from "drizzle-orm/sqlite-core";
import type {DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import {normalizeSearchText} from "./normalize.ts";

// Statement-shape shims for the FTS5 virtual tables (real DDL lives in
// `migrations/0002_search_fts.sql`). Only the columns the write path touches.
const termSearch = sqliteTable("term_search", {
	slug: text("slug").primaryKey(),
	norm: text("norm").notNull(),
});

const postSearch = sqliteTable("post_search", {
	id: text("id").primaryKey(),
	norm: text("norm").notNull(),
});

/** Upsert a term's FTS row (keyed by slug). Indexes the normalized title. */
export const syncTermSearch = (db: DrizzleDb, slug: string, title: string): [Stmt, Stmt] => [
	db.delete(termSearch).where(eq(termSearch.slug, slug)),
	db.insert(termSearch).values({slug, norm: normalizeSearchText(title)}),
];

/** Remove a term's FTS row (term deleted / no longer searchable). */
export const removeTermSearch = (db: DrizzleDb, slug: string): Stmt =>
	db.delete(termSearch).where(eq(termSearch.slug, slug));

/** Upsert a post's FTS row (keyed by id). Indexes the normalized title. */
export const syncPostSearch = (db: DrizzleDb, id: string, title: string): [Stmt, Stmt] => [
	db.delete(postSearch).where(eq(postSearch.id, id)),
	db.insert(postSearch).values({id, norm: normalizeSearchText(title)}),
];

/** Remove a post's FTS row (post deleted). */
export const removePostSearch = (db: DrizzleDb, id: string): Stmt =>
	db.delete(postSearch).where(eq(postSearch.id, id));
