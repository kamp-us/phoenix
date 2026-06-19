/**
 * Bookmark — per-user post bookmark ("kaydet") service. The structural twin of
 * {@link Vote} stripped to pure presence: no score, no karma, no hot-score
 * recompute. A `post_bookmark` row means saved; its absence means not.
 *
 * `toggle` is idempotent (probe-then-write, like `Vote.cast`): re-saving an
 * already-saved post — or un-saving an unsaved one — is a no-op that writes
 * nothing and returns `changed: false`. `readMine` is the batched presence read
 * `#128` will stamp `isSaved` from without an N+1.
 */
import {and, desc, eq, inArray, isNull} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {PostNotFound} from "./errors.ts";

export interface BookmarkToggleInput {
	userId: string;
	postId: string;
	saved: boolean;
}

export interface BookmarkToggleResult {
	postId: string;
	saved: boolean;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}

/**
 * A keyset page of the viewer's saved post ids, newest save first. Carries the
 * ordered ids only — hydration (the `isSaved`/`myVote` batch stamp + post shape)
 * stays in `Pano.getPostsByIds`, so `Bookmark` owns the `post_bookmark` keyset
 * and `Pano` owns the post row. The cursor is the bookmark's `post_id` (unique
 * per user, the `(post_id, user_id)` PK).
 */
export interface SavedPostsPage {
	ids: string[];
	hasNextPage: boolean;
	endCursor: string | null;
}

export class Bookmark extends Context.Service<
	Bookmark,
	{
		readonly toggle: (
			input: BookmarkToggleInput,
		) => Effect.Effect<BookmarkToggleResult, PostNotFound>;
		/**
		 * Batched presence read: the subset of `postIds` the viewer has saved, in
		 * one `IN (...)` read so #128 stamps `isSaved` without an N+1. Missing
		 * viewer or empty `postIds` short-circuits to an empty Set with no read.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			postIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;
		/**
		 * Keyset page of the viewer's saved post ids, ordered by save time
		 * (`post_bookmark.created_at DESC, post_id DESC`) over the
		 * `(user_id, created_at DESC)` index (#127). Inner-joins `post_summary` so
		 * a soft-deleted post never appears. Missing viewer → empty page, no read.
		 */
		readonly listSavedConnection: (
			viewerId: string | null | undefined,
			opts?: {first?: number | undefined; after?: string | null | undefined},
		) => Effect.Effect<SavedPostsPage>;
	}
>()("@kampus/pano/Bookmark") {}

export const BookmarkLive = Layer.effect(Bookmark)(
	Effect.gen(function* () {
		// `orDieAccess`: DB failures are defects (domain-boundary rule), so the
		// public signature carries `PostNotFound` only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);

		const readMine = Effect.fn("Bookmark.readMine")(function* (
			viewerId: string | null | undefined,
			postIds: ReadonlyArray<string>,
		) {
			if (!viewerId || postIds.length === 0) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({postId: schema.postBookmark.postId})
					.from(schema.postBookmark)
					.where(
						and(
							eq(schema.postBookmark.userId, viewerId),
							inArray(schema.postBookmark.postId, [...postIds]),
						),
					),
			);
			return new Set(rows.map((r) => r.postId));
		});

		const listSavedConnection = Effect.fn("Bookmark.listSavedConnection")(function* (
			viewerId: string | null | undefined,
			opts: {first?: number | undefined; after?: string | null | undefined} = {},
		) {
			if (!viewerId) return {ids: [], hasNextPage: false, endCursor: null} satisfies SavedPostsPage;

			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			// The DB read is the port; `resolveCursor` is the pure cursor-miss
			// decision (see `Pano.listPostsConnection`). `after` is a bookmark
			// `post_id`; resolve it to its `created_at` for the keyset tuple.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.postBookmark.createdAt})
							.from(schema.postBookmark)
							.where(
								and(
									eq(schema.postBookmark.userId, viewerId),
									eq(schema.postBookmark.postId, after),
								),
							)
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {ids: [], hasNextPage: false, endCursor: null} satisfies SavedPostsPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			const cursorPredicate = keysetAfter([
				{column: schema.postBookmark.createdAt, dir: "desc", value: cursorRow?.createdAt ?? null},
				{column: schema.postBookmark.postId, dir: "desc", value: after},
			]);

			const baseWhere = and(
				eq(schema.postBookmark.userId, viewerId),
				isNull(schema.postSummary.deletedAt),
			);

			const fetched = yield* run((db) =>
				db
					.select({postId: schema.postBookmark.postId})
					.from(schema.postBookmark)
					.innerJoin(schema.postSummary, eq(schema.postSummary.id, schema.postBookmark.postId))
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(desc(schema.postBookmark.createdAt), desc(schema.postBookmark.postId))
					.limit(first + 1),
			);

			const page = forwardPage<{postId: string}, string>(
				fetched,
				first,
				(id) => id,
				(r) => r.postId,
			);
			return {ids: page.rows, hasNextPage: page.hasNextPage, endCursor: page.endCursor};
		});

		return {
			readMine,
			listSavedConnection,
			toggle: Effect.fn("Bookmark.toggle")(function* (input: BookmarkToggleInput) {
				const post = yield* run((db) =>
					db.query.postSummary.findFirst({
						where: {id: input.postId, deletedAt: {isNull: true}},
						columns: {id: true},
					}),
				);
				if (!post) {
					return yield* new PostNotFound({
						postId: input.postId,
						message: `bookmark target post ${input.postId} not found`,
					});
				}

				const existing = yield* run((db) =>
					db.query.postBookmark.findFirst({
						where: {postId: input.postId, userId: input.userId},
						columns: {postId: true},
					}),
				);
				const alreadySaved = existing != null;

				if (input.saved === alreadySaved) {
					return {
						postId: input.postId,
						saved: alreadySaved,
						changed: false,
					} satisfies BookmarkToggleResult;
				}

				yield* batch((db) =>
					input.saved
						? ([
								db
									.insert(schema.postBookmark)
									.values({
										postId: input.postId,
										userId: input.userId,
										createdAt: new Date(),
									})
									.onConflictDoNothing(),
							] as const)
						: ([
								db
									.delete(schema.postBookmark)
									.where(
										and(
											eq(schema.postBookmark.postId, input.postId),
											eq(schema.postBookmark.userId, input.userId),
										),
									),
							] as const),
				);

				return {
					postId: input.postId,
					saved: input.saved,
					changed: true,
				} satisfies BookmarkToggleResult;
			}),
		};
	}),
);
