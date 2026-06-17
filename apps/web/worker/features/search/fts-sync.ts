/**
 * Dual-write FTS sync (ADR 0080). The FTS5 virtual tables `term_search` /
 * `post_search` are kept in lockstep with `term_summary` / `post_summary` from
 * the application write path — NOT D1 triggers — so the worker that owns every
 * write to a summary row writes its search row in the same place.
 *
 * These are `sql` statement builders (delete-then-insert upsert: FTS5 has no
 * `ON CONFLICT`, so a re-sync removes the old row by key first). A feature service
 * runs them through its own `Drizzle.run` at the point it mutates the summary, so
 * the sync stays co-located with the write and never crosses a service boundary.
 *
 * The indexed `norm` column is the Turkish-normalized title (see `normalize.ts`);
 * the `slug`/`id` column is `UNINDEXED`, carried only to join the match back to
 * the summary row.
 */

import {type SQL, sql} from "drizzle-orm";
import {normalizeSearchText} from "./normalize.ts";

/** Upsert a term's FTS row (keyed by slug). Indexes the normalized title. */
export const syncTermSearch = (slug: string, title: string): SQL[] => [
	sql`DELETE FROM term_search WHERE slug = ${slug}`,
	sql`INSERT INTO term_search (slug, norm) VALUES (${slug}, ${normalizeSearchText(title)})`,
];

/** Remove a term's FTS row (term deleted / no longer searchable). */
export const removeTermSearch = (slug: string): SQL =>
	sql`DELETE FROM term_search WHERE slug = ${slug}`;

/** Upsert a post's FTS row (keyed by id). Indexes the normalized title. */
export const syncPostSearch = (id: string, title: string): SQL[] => [
	sql`DELETE FROM post_search WHERE id = ${id}`,
	sql`INSERT INTO post_search (id, norm) VALUES (${id}, ${normalizeSearchText(title)})`,
];

/** Remove a post's FTS row (post deleted). */
export const removePostSearch = (id: string): SQL => sql`DELETE FROM post_search WHERE id = ${id}`;
