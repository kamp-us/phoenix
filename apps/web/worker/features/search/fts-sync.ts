/**
 * Dual-write FTS sync (ADR 0080). The FTS5 virtual tables `term_search` /
 * `post_search` are kept in lockstep with `term_summary` / `post_summary` from
 * the application write path — NOT D1 triggers — so the worker that owns every
 * write to a summary row writes its search row in the same place.
 *
 * These are `sql` statement builders (delete-then-insert upsert: FTS5 has no
 * `ON CONFLICT`, so a re-sync removes the old row by key first). The module stays
 * shallow (ADR 0080): it builds statements and never crosses a service boundary —
 * the caller composes them, alongside the summary write, into ONE `Drizzle.batch`
 * so the summary row and its FTS row move all-or-none (the lockstep invariant ADR
 * 0080 stakes the design on; a crash between the two can never desync them).
 * `ftsBatchItems` is the single home of the "sync within this batch" composition:
 * callers fold the `SQL[]` to batch items through it instead of re-spelling a
 * separate-`run` loop per site.
 *
 * The indexed `norm` column is the Turkish-normalized title (see `normalize.ts`);
 * the `slug`/`id` column is `UNINDEXED`, carried only to join the match back to
 * the summary row.
 */

import {type SQL, sql} from "drizzle-orm";
import type {Stmt} from "../../db/Drizzle.ts";
import {normalizeSearchText} from "./normalize.ts";

/** A `db.run`-shaped runner — the one method this module needs to fold `SQL` into batch items. */
type SqlRunner = {readonly run: (stmt: SQL) => Stmt};

/**
 * Fold FTS sync `SQL[]` into `Drizzle.batch` items, so a caller composes them
 * into the SAME batch as its summary write — the all-or-none seam (ADR 0080).
 * Stays shallow: a pure map of `sql` → `db.run(sql)`, owning no execution.
 */
export const ftsBatchItems = (db: SqlRunner, statements: readonly SQL[]): Stmt[] =>
	statements.map((stmt) => db.run(stmt));

/** Upsert a term's FTS row (keyed by slug). Indexes the normalized title. */
export const syncTermSearch = (slug: string, title: string): [SQL, SQL] => [
	sql`DELETE FROM term_search WHERE slug = ${slug}`,
	sql`INSERT INTO term_search (slug, norm) VALUES (${slug}, ${normalizeSearchText(title)})`,
];

/** Remove a term's FTS row (term deleted / no longer searchable). */
export const removeTermSearch = (slug: string): SQL =>
	sql`DELETE FROM term_search WHERE slug = ${slug}`;

/** Upsert a post's FTS row (keyed by id). Indexes the normalized title. */
export const syncPostSearch = (id: string, title: string): [SQL, SQL] => [
	sql`DELETE FROM post_search WHERE id = ${id}`,
	sql`INSERT INTO post_search (id, norm) VALUES (${id}, ${normalizeSearchText(title)})`,
];

/** Remove a post's FTS row (post deleted). */
export const removePostSearch = (id: string): SQL => sql`DELETE FROM post_search WHERE id = ${id}`;
