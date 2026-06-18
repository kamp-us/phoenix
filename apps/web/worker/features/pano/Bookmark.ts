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
import {and, eq, inArray} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
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

		return {
			readMine,
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
