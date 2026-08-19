/**
 * The pano-wide `pano_stats` cache — the one read model spanning both planes (post + comment
 * + author totals), so it lives apart from either plane's operations. Written by the
 * source-mutation path, not the query-only stats feature (ADR 0117).
 */
import {sql} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {anonymousViewer} from "../lifecycle/EntityLifecycle.ts";
import {publicLiveWhere} from "../lifecycle/SandboxVisibility.ts";
import {publicLivePostWhere} from "./PostVisibility.ts";

export interface PanoStatsCounts {
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

export interface PanoStats {
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	updatedAt: number;
}

// `updatedAt` is unix seconds, matching the column.
export const recomputePanoStats = (counts: PanoStatsCounts, now: Date): PanoStats => ({
	totalPosts: counts.totalPosts,
	totalComments: counts.totalComments,
	totalAuthors: counts.totalAuthors,
	updatedAt: Math.floor(now.getTime() / 1000),
});

export const makePersistPanoStats = (run: DrizzleAccessOrDie["run"]) =>
	Effect.fn("Pano.recomputePanoStats")(function* (now: Date) {
		// Public counts are LIVE-only for the anonymous viewer. Posts route through the
		// post-aware predicate so drafts are excluded too (a draft-only author never inflates the
		// totals); comments have no draft dimension.
		const postWhere = publicLivePostWhere(
			{
				removedAt: schema.postRecord.removedAt,
				sandboxedAt: schema.postRecord.sandboxedAt,
				authorId: schema.postRecord.authorId,
				isDraft: schema.postRecord.isDraft,
			},
			anonymousViewer,
		);
		const commentWhere = publicLiveWhere(
			{
				removedAt: schema.commentRecord.removedAt,
				sandboxedAt: schema.commentRecord.sandboxedAt,
				authorId: schema.commentRecord.authorId,
			},
			anonymousViewer,
		);
		const totalPosts = yield* run((db) =>
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.postRecord)
				.where(postWhere)
				.then((r) => Number(r[0]?.n ?? 0)),
		);
		const totalComments = yield* run((db) =>
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.commentRecord)
				.where(commentWhere)
				.then((r) => Number(r[0]?.n ?? 0)),
		);
		const totalAuthors = yield* run((db) =>
			db
				.run(
					sql`SELECT COUNT(DISTINCT author_id) as n FROM (
							SELECT author_id FROM post_record WHERE ${postWhere}
							UNION
							SELECT author_id FROM comment_record WHERE ${commentWhere}
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

export type PersistPanoStats = ReturnType<typeof makePersistPanoStats>;
