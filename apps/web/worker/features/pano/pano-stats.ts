/**
 * The pano-wide `pano_stats` cache — the one read model that spans both planes
 * (post + comment + author totals), so it lives apart from either plane's
 * operations. A pure fold (`recomputePanoStats`) decides the row from the three
 * live COUNTs + the write clock (ADR 0082), and `makePersistPanoStats` is the thin
 * port that gathers the COUNTs and upserts.
 */
import {and, isNull, sql} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/** The three live COUNTs the pano-stats fold reads. */
export interface PanoStatsCounts {
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

/** The `pano_stats` row the upsert persists — fully derived from the counts + `now`. */
export interface PanoStats {
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	updatedAt: number;
}

/**
 * Pure stats fold: `pano_stats` is fully derived from the three live COUNTs + the
 * write clock (ADR 0082 — the decision lifted above the Drizzle seam). `updatedAt`
 * is unix seconds, matching the column.
 */
export const recomputePanoStats = (counts: PanoStatsCounts, now: Date): PanoStats => ({
	totalPosts: counts.totalPosts,
	totalComments: counts.totalComments,
	totalAuthors: counts.totalAuthors,
	updatedAt: Math.floor(now.getTime() / 1000),
});

/**
 * Build the `persistPanoStats` port: gather the three live COUNTs via `run`, call
 * the pure `recomputePanoStats` fold, persist via the upsert. Runs after every write
 * that could affect totals. The closure keeps the `Pano.recomputePanoStats` span name.
 */
export const makePersistPanoStats = (run: DrizzleAccessOrDie["run"]) =>
	Effect.fn("Pano.recomputePanoStats")(function* (now: Date) {
		// Public stats count LIVE content only: a sandboxed çaylak post/comment
		// (#1205) is pending, excluded from the landing totals like a removed one.
		const totalPosts = yield* run((db) =>
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.postRecord)
				.where(and(isNull(schema.postRecord.removedAt), isNull(schema.postRecord.sandboxedAt)))
				.then((r) => Number(r[0]?.n ?? 0)),
		);
		const totalComments = yield* run((db) =>
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.commentRecord)
				.where(
					and(isNull(schema.commentRecord.removedAt), isNull(schema.commentRecord.sandboxedAt)),
				)
				.then((r) => Number(r[0]?.n ?? 0)),
		);
		const totalAuthors = yield* run((db) =>
			db
				.run(
					sql`SELECT COUNT(DISTINCT author_id) as n FROM (
							SELECT author_id FROM post_record WHERE removed_at IS NULL AND sandboxed_at IS NULL
							UNION
							SELECT author_id FROM comment_record WHERE removed_at IS NULL AND sandboxed_at IS NULL
						)`,
				)
				.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
		);

		const stats = recomputePanoStats({totalPosts, totalComments, totalAuthors}, now);
		yield* run((db) =>
			db.run(sql`
				INSERT INTO pano_stats (id, total_posts, total_comments, total_authors, updated_at)
				VALUES (1, ${stats.totalPosts}, ${stats.totalComments}, ${stats.totalAuthors}, ${stats.updatedAt})
				ON CONFLICT(id) DO UPDATE SET
					total_posts    = excluded.total_posts,
					total_comments = excluded.total_comments,
					total_authors  = excluded.total_authors,
					updated_at     = excluded.updated_at
			`),
		);
	});

/** The `persistPanoStats` port type, shared by both plane operation factories. */
export type PersistPanoStats = ReturnType<typeof makePersistPanoStats>;
