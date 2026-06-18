/**
 * The read-side slice of the phoenix D1 schema this backfill scans — just the
 * key + title (+ `deleted_at` for posts) of `term_summary` / `post_summary`. A
 * deliberately narrow local copy (the `preview-seed` idiom) so the tool stays a
 * self-contained `packages/` CLI rather than pulling the worker's full schema
 * graph; only the columns the backfill reads.
 *
 * The *write* side is NOT copied — the FTS upsert SQL is the worker's own
 * `syncTermSearch` / `syncPostSearch` (imported from `@kampus/web`), so the
 * indexed `norm` is byte-identical to the dual-write (issue #534's hard
 * constraint: same normalization, or backfilled rows won't match queries).
 */
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const termSummary = sqliteTable("term_summary", {
	slug: text("slug").primaryKey(),
	title: text("title").notNull(),
});

export const postSummary = sqliteTable("post_summary", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	deletedAt: integer("deleted_at", {mode: "timestamp"}),
});

export const backfillSchema = {termSummary, postSummary};
export type BackfillSchema = typeof backfillSchema;
