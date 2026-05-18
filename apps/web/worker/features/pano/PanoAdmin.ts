/**
 * Pano admin service — operations the dev-only `/api/admin/pano/*` routes call
 * after `AdminAuth.required` succeeds.
 *
 *   - `seedPosts` — wipe (optional) + insert the in-worker `SEED_POSTS` fixture
 *     used by the dev importer. Each post is created via the same lifecycle as
 *     a user-driven `submitPost`, so post_summary / pano_stats land identically.
 *
 * Lives in a separate service from `Pano` per ADR 0012: admin operations
 * shouldn't pollute the resolver context and are gated by `AdminAuth.required`
 * rather than `Auth.required`. `PanoAdminLive` depends only on `Drizzle` (the
 * seed flow doesn't need vote logic — fresh posts start at score 0).
 */
import {id} from "@usirin/forge";
import {sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import * as schema from "../../db/drizzle/schema";
import {Drizzle, type DrizzleError} from "../../services/Drizzle";
import {excerpt as excerptText} from "../../shared/text";
import {SEED_POSTS, type SeedPost} from "./seed";

const POST_EXCERPT_LEN = 280;

const excerpt = (body: string): string => excerptText(body, POST_EXCERPT_LEN);

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface SeedPostsInput {
	clear?: boolean | undefined;
	/** Defaults to the in-worker `SEED_POSTS` fixture; tests can override. */
	posts?: ReadonlyArray<SeedPost> | undefined;
}

export interface SeedPostsResult {
	inserted: number;
	postIds: string[];
	cleared: {posts: number; comments: number};
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class PanoAdmin extends Context.Service<
	PanoAdmin,
	{
		readonly seedPosts: (input: SeedPostsInput) => Effect.Effect<SeedPostsResult, DrizzleError>;
	}
>()("@phoenix/pano/PanoAdmin") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const PanoAdminLive = Layer.effect(PanoAdmin)(
	Effect.gen(function* () {
		const {run, batch} = yield* Drizzle;

		/**
		 * Recompute `pano_stats` totals — same shape as Pano's closure-private
		 * helper, duplicated here so PanoAdmin's `R` channel stays `Drizzle`
		 * only (no cross-service dep on `Pano`).
		 */
		const recomputePanoStats = Effect.fn("PanoAdmin.recomputePanoStats")(function* (now: Date) {
			const totalPosts = yield* run((db) =>
				db
					.run(sql`SELECT COUNT(*) as n FROM post_summary WHERE deleted_at IS NULL`)
					.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
			);
			const totalComments = yield* run((db) =>
				db
					.run(sql`SELECT COUNT(*) as n FROM comment_view WHERE deleted_at IS NULL`)
					.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
			);
			const totalAuthors = yield* run((db) =>
				db
					.run(
						sql`SELECT COUNT(DISTINCT author_id) as n FROM (
								SELECT author_id FROM post_summary WHERE deleted_at IS NULL
								UNION
								SELECT author_id FROM comment_view WHERE deleted_at IS NULL
							)`,
					)
					.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
			);

			const nowSec = Math.floor(now.getTime() / 1000);
			yield* run((db) =>
				db.run(sql`
					INSERT INTO pano_stats (id, total_posts, total_comments, total_authors, updated_at)
					VALUES (1, ${totalPosts}, ${totalComments}, ${totalAuthors}, ${nowSec})
					ON CONFLICT(id) DO UPDATE SET
						total_posts    = excluded.total_posts,
						total_comments = excluded.total_comments,
						total_authors  = excluded.total_authors,
						updated_at     = excluded.updated_at
				`),
			);
		});

		const seedPosts = Effect.fn("PanoAdmin.seedPosts")(function* (input: SeedPostsInput) {
			const cleared = {posts: 0, comments: 0};
			if (input.clear) {
				const postsBefore = yield* run((db) =>
					db
						.run(sql`SELECT COUNT(*) AS n FROM post_summary`)
						.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
				);
				const commentsBefore = yield* run((db) =>
					db
						.run(sql`SELECT COUNT(*) AS n FROM comment_view`)
						.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0)),
				);
				cleared.posts = postsBefore;
				cleared.comments = commentsBefore;
				yield* batch((db) => [
					db.run(sql`DELETE FROM comment_vote`),
					db.run(sql`DELETE FROM post_vote`),
					db.run(sql`DELETE FROM comment_view`),
					db.run(sql`DELETE FROM post_summary`),
					db.run(sql`DELETE FROM pano_stats`),
				]);
			}

			const posts = input.posts ?? SEED_POSTS;
			const postIds: string[] = [];
			let inserted = 0;
			const now = new Date();
			for (const seed of posts) {
				const postId = id("post");
				let host: string | null = null;
				let urlNormalized: string | null = null;
				if (seed.url != null && seed.url.length > 0) {
					// Skip malformed seed URLs rather than failing the whole
					// seed; the fixture data is hand-maintained and stable.
					const parsed = yield* Effect.try({
						try: () => new URL(seed.url as string),
						catch: () => null as null,
					}).pipe(Effect.orElseSucceed(() => null as URL | null));
					if (parsed) {
						urlNormalized = parsed.toString();
						host = parsed.host;
					}
				}
				const body = seed.body ?? null;
				const bodyExcerpt = body ? excerpt(body) : null;
				const tagsCsv = seed.tags.map((t) => t.kind).join(",");

				yield* run((db) =>
					db.insert(schema.postSummary).values({
						id: postId,
						slug: null,
						title: seed.title,
						url: urlNormalized,
						host,
						body: body ?? "",
						bodyExcerpt: bodyExcerpt ?? "",
						authorId: seed.authorId,
						authorName: seed.authorName,
						tags: tagsCsv,
						score: 0,
						commentCount: 0,
						hotScore: 0,
						createdAt: now,
						updatedAt: now,
						lastActivityAt: now,
						deletedAt: null,
						lastEventId: "",
					}),
				);
				postIds.push(postId);
				inserted++;

				// Two-pass: top-level first so children can reference parents.
				const insertedIds: string[] = [];
				let commentCount = 0;
				for (const cmt of seed.comments) {
					const parentId = cmt.parentIdx != null ? (insertedIds[cmt.parentIdx] ?? null) : null;
					const commentId = id("comm");
					yield* run((db) =>
						db.insert(schema.commentView).values({
							id: commentId,
							authorId: cmt.authorId,
							authorName: cmt.authorName,
							postId,
							postTitle: seed.title,
							parentId,
							body: cmt.body,
							bodyExcerpt: excerpt(cmt.body),
							score: 0,
							createdAt: now,
							updatedAt: now,
							deletedAt: null,
							lastEventId: "",
						}),
					);
					insertedIds.push(commentId);
					commentCount++;
				}

				if (commentCount > 0) {
					yield* run((db) =>
						db.run(sql`
							UPDATE post_summary SET
								comment_count    = ${commentCount},
								updated_at       = ${Math.floor(now.getTime() / 1000)},
								last_activity_at = ${Math.floor(now.getTime() / 1000)}
							WHERE id = ${postId}
						`),
					);
				}
			}

			yield* recomputePanoStats(now);

			return {inserted, postIds, cleared} satisfies SeedPostsResult;
		});

		return {seedPosts};
	}),
);
