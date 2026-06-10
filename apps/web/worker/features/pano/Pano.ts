/**
 * Pano — the link aggregator / discussion feature service.
 *
 * Resolver-facing surface for post + comment CRUD, vote delegation, and
 * connection-shaped pagination. Every method in this file replaces an async
 * export from the legacy `worker/features/pano/module.ts` +
 * `postSummaryReader.ts` + `commentViewReader.ts` files. Wire codes and result
 * shapes are preserved identically; the only thing that changes is the call
 * form (Effect over Promise).
 *
 * Vote mutations (`voteOnPost`, `retractPostVote`, `voteOnComment`,
 * `retractCommentVote`) delegate to `Vote.cast` rather than reimplementing the
 * batched vote / karma / score-cache logic. Pano-side wrappers re-load the
 * target row for the canonical resolver shape and translate
 * `VoteTargetNotFound` into `PostNotFound` / `CommentNotFound` so the resolver
 * codec keeps producing `POST_NOT_FOUND` / `COMMENT_NOT_FOUND`.
 *
 * Validation lives inside the service methods as closure helpers (ADR 0013).
 * `computeHotScore`, `recomputePanoStats`, and the comment tree denormalization
 * helpers are also closure-private — they're load-bearing but not part of the
 * public surface.
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, type DrizzleError} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, keysetAfter} from "../../db/keyset.ts";
import {excerpt as excerptText} from "../text/index.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";
import {Vote} from "../vote/Vote.ts";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
	type CommentValidation,
	ParentCommentNotFound,
	PostBodyTooLong,
	PostNotFound,
	type PostValidation,
	TagInvalid,
	TagsRequired,
	TitleRequired,
	TitleTooLong,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
	UrlInvalid,
} from "./errors.ts";

/* -------------------------------------------------------------------------- */
/* Domain constants                                                            */
/* -------------------------------------------------------------------------- */

/** Title cap (per PRD). */
export const POST_TITLE_MAX = 200;
/** Body cap on submit / edit (per PRD). */
export const POST_BODY_MAX = 10_000;
/** Comment body cap (per PRD). */
export const COMMENT_BODY_MAX = 5_000;

/** Pano excerpt cap (tweet-sized, matches pre-effect-migration). */
const POST_EXCERPT_LEN = 280;

const excerpt = (body: string): string => excerptText(body, POST_EXCERPT_LEN);

/**
 * Fixed tag enum for Pano posts (per PRD). Resolver-side validation enforces
 * the same set, but the service is the durability boundary so it re-validates.
 * Stored on `post_summary.tags` as comma-separated values.
 */
export const ALLOWED_POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

export type AllowedPostTagKind = (typeof ALLOWED_POST_TAG_KINDS)[number];

/**
 * Placeholder body rendered in place of a soft-deleted comment that still has
 * non-deleted replies (parent-with-replies path). The leaf-deleted path
 * removes the row entirely so the placeholder never appears there.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

/**
 * Static label map for the fixed tag enum. Covers the Turkish source-of-truth
 * kinds plus the legacy English aliases that may exist in seed data. Falls
 * back to the raw kind so unknown tags still render.
 */
const TAG_LABELS: Record<string, string> = {
	göster: "göster",
	tartışma: "tartışma",
	soru: "soru",
	söylenme: "söylenme",
	meta: "meta",
	// Legacy English aliases that may exist in seed data.
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
};

/**
 * Resolve a tag `kind` to its display `label` via the static label map, falling
 * back to the raw kind. Used by `parseTags` and the fate `Tag` source `byIds`.
 */
export function tagLabel(kind: string): string {
	return TAG_LABELS[kind] ?? kind;
}

function parseTags(csv: string): Array<{kind: string; label: string}> {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: tagLabel(kind)}));
}

/* -------------------------------------------------------------------------- */
/* Read shapes                                                                 */
/* -------------------------------------------------------------------------- */

export interface PostTagRow {
	kind: string;
	label: string;
}

export interface PostPage {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	updatedAt: Date;
	tags: PostTagRow[];
}

export type PostSort = "hot" | "new" | "top" | "discuss";

export interface PostSummaryRow {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	updatedAt?: Date;
	tags: PostTagRow[];
	/**
	 * Viewer's upvote flag (`1` | `null`). Populated by the fate batch reads
	 * (`getPostsByIds`, `listPostsKeyset`-shaped pages) so the `Post.myVote` view
	 * field is a stamped scalar; `undefined` for read paths that don't request it
	 * (leaving this unset on `PostSummaryRow`).
	 */
	myVote?: number | null;
}

export interface PostConnectionPage {
	rows: PostSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

export interface CommentRow {
	id: string;
	parentId: string | null;
	author: string;
	authorId: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
	deletedAt?: Date | null;
	/**
	 * Viewer's upvote flag (`1` | `null`). Populated by the fate batch reads
	 * (`getCommentsByIds`, `listCommentsKeyset`) so the `Comment.myVote` view
	 * field is a stamped scalar; `undefined` for read paths that don't request it
	 * (leaving this unset).
	 */
	myVote?: number | null;
}

export interface CommentConnectionPage {
	rows: CommentRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/* -------------------------------------------------------------------------- */
/* Mutation shapes                                                             */
/* -------------------------------------------------------------------------- */

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: string;
	authorName: string;
}

export interface SubmitPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
}

export interface VoteOnPostInput {
	postId: string;
	voterId: string;
}

export interface VoteOnPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	myVote: number | null;
	changed: boolean;
}

export interface EditPostInput {
	postId: string;
	actorId: string;
	title?: string | undefined;
	body?: string | undefined;
}

export interface EditPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	updatedAt: Date;
}

export interface DeletePostInput {
	postId: string;
	actorId: string;
}

export interface DeletePostResult {
	postId: string;
	deleted: boolean;
}

export interface AddCommentInput {
	postId: string;
	authorId: string;
	authorName: string;
	body: string;
	parentId?: string | null | undefined;
}

export interface AddCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	commentCount: number;
	createdAt: Date;
}

export interface VoteOnCommentInput {
	commentId: string;
	voterId: string;
}

export interface VoteOnCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	myVote: number | null;
	changed: boolean;
}

export interface EditCommentInput {
	commentId: string;
	actorId: string;
	body: string;
}

export interface EditCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteCommentInput {
	commentId: string;
	actorId: string;
}

export interface DeleteCommentResult {
	commentId: string;
	deleted: boolean;
	hasReplies: boolean;
	placeholder: CommentRow | null;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class Pano extends Context.Service<
	Pano,
	{
		readonly getPost: (postId: string) => Effect.Effect<PostPage | null, DrizzleError>;

		readonly listPostsConnection: (opts?: {
			sort?: PostSort;
			first?: number;
			after?: string | null;
			host?: string | null;
		}) => Effect.Effect<PostConnectionPage, DrizzleError>;

		/**
		 * DB-keyset page over a post's comments in chronological-asc order
		 * `(created_at asc, id asc)`, cursor = comment id. A bounded
		 * `WHERE … LIMIT first+1` with no skips/dupes. `viewerId` stamps
		 * `myVote` for the whole page in one `user_vote` read.
		 */
		readonly listCommentsKeyset: (
			postId: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			},
		) => Effect.Effect<CommentConnectionPage, DrizzleError>;

		/** Post source `byIds` — batched read avoiding the relation N+1. */
		readonly getPostsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<ReadonlyArray<PostSummaryRow>, DrizzleError>;

		/** Comment source `byIds` — batched read avoiding the relation N+1. */
		readonly getCommentsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<ReadonlyArray<CommentRow>, DrizzleError>;

		/** Resolve a comment's parent post id (for re-resolving on delete). */
		readonly lookupCommentPostId: (commentId: string) => Effect.Effect<string | null, DrizzleError>;

		readonly submitPost: (
			input: SubmitPostInput,
		) => Effect.Effect<SubmitPostResult, PostValidation | DrizzleError>;

		readonly editPost: (
			input: EditPostInput,
		) => Effect.Effect<
			EditPostResult,
			PostValidation | PostNotFound | UnauthorizedPostMutation | DrizzleError
		>;

		readonly deletePost: (
			input: DeletePostInput,
		) => Effect.Effect<DeletePostResult, UnauthorizedPostMutation | DrizzleError>;

		readonly voteOnPost: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound | DrizzleError>;

		readonly retractPostVote: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound | DrizzleError>;

		readonly addComment: (
			input: AddCommentInput,
		) => Effect.Effect<AddCommentResult, CommentValidation | PostNotFound | DrizzleError>;

		readonly editComment: (
			input: EditCommentInput,
		) => Effect.Effect<
			EditCommentResult,
			CommentValidation | CommentNotFound | UnauthorizedCommentMutation | DrizzleError
		>;

		readonly deleteComment: (
			input: DeleteCommentInput,
		) => Effect.Effect<
			DeleteCommentResult,
			CommentNotFound | UnauthorizedCommentMutation | DrizzleError
		>;

		readonly voteOnComment: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound | DrizzleError>;

		readonly retractCommentVote: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound | DrizzleError>;
	}
>()("@phoenix/pano/Pano") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const PanoLive = Layer.effect(Pano)(
	Effect.gen(function* () {
		// Yield Drizzle and Vote once at layer build and destructure/close over
		// their bound methods. Method bodies call `run` / `batch` / `voteSvc`
		// directly — the deps are owned by this layer, so every method's `R`
		// stays `never` (the dep never reaches the caller-visible R channel).
		const {run, batch} = yield* Drizzle;
		const voteSvc = yield* Vote;

		/* ------------------------------------------------------------------ */
		/* Closure-private helpers                                             */
		/* ------------------------------------------------------------------ */

		/**
		 * HN-style hot score: `score / (hours_old + 2)^1.8`. Multiplied by 1000
		 * and floored so the persisted column stays an integer (D1 indexes
		 * integers cheaper than floats and the relative ordering is what
		 * matters).
		 */
		const computeHotScore = (score: number, createdAtMs: number, nowMs: number): number => {
			const hoursOld = Math.max(0, (nowMs - createdAtMs) / 3_600_000);
			const denom = (hoursOld + 2) ** 1.8;
			return Math.floor((score * 1000) / denom);
		};

		const rowToPostPage = (row: typeof schema.postSummary.$inferSelect): PostPage => ({
			id: row.id,
			slug: row.slug,
			title: row.title,
			url: row.url,
			host: row.host,
			body: row.body && row.body.length > 0 ? row.body : null,
			author: row.authorName,
			authorId: row.authorId,
			score: row.score,
			commentCount: row.commentCount,
			createdAt: row.createdAt ?? new Date(0),
			updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
			tags: parseTags(row.tags),
		});

		/**
		 * Reply-aware projection: a row with `deletedAt` set is the
		 * parent-with-replies case. Leaf-deleted rows are removed entirely
		 * from `comment_view`, so they never reach this branch — but if they
		 * somehow did, we surface the placeholder shape.
		 */
		const rowToCommentRow = (row: typeof schema.commentView.$inferSelect): CommentRow => {
			if (row.deletedAt) {
				return {
					id: row.id,
					parentId: row.parentId,
					author: "",
					authorId: "",
					body: SILINDI_PLACEHOLDER,
					score: row.score,
					createdAt: row.createdAt ?? new Date(0),
					updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
					deletedAt: row.deletedAt,
				};
			}
			return {
				id: row.id,
				parentId: row.parentId,
				author: row.authorName,
				authorId: row.authorId,
				body: row.body,
				score: row.score,
				createdAt: row.createdAt ?? new Date(0),
				updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
				deletedAt: null,
			};
		};

		/**
		 * Refresh `pano_stats` totals. Three small COUNT queries plus one
		 * upsert. Cheap; runs after every write that could affect totals.
		 */
		const recomputePanoStats = Effect.fn("Pano.recomputePanoStats")(function* (now: Date) {
			const totalPosts = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.postSummary)
					.where(isNull(schema.postSummary.deletedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalComments = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.commentView)
					.where(isNull(schema.commentView.deletedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
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

		/**
		 * Body validation for `submitPost` / `editPost`. Returns the normalized
		 * body (or `null` for empty) when valid; fails with `PostValidation`
		 * otherwise. Per ADR 0013, validation lives in service methods, not
		 * resolvers.
		 */
		const validatePostBody = Effect.fn("Pano.validatePostBody")(function* (rawBody: string) {
			if (rawBody.length > POST_BODY_MAX) {
				return yield* new PostBodyTooLong({
					message: `metin en fazla ${POST_BODY_MAX} karakter olabilir`,
				});
			}
			return rawBody.length === 0 ? null : rawBody;
		});

		const validatePostTitle = Effect.fn("Pano.validatePostTitle")(function* (raw: string) {
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return yield* new TitleRequired({
					message: "başlık boş olamaz",
				});
			}
			if (trimmed.length > POST_TITLE_MAX) {
				return yield* new TitleTooLong({
					message: `başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
				});
			}
			return trimmed;
		});

		const validateCommentBody = Effect.fn("Pano.validateCommentBody")(function* (
			body: string | null | undefined,
		) {
			const rawBody = body ?? "";
			if (rawBody.trim().length === 0) {
				return yield* new CommentBodyRequired({
					message: "yorum boş olamaz",
				});
			}
			if (rawBody.length > COMMENT_BODY_MAX) {
				return yield* new CommentBodyTooLong({
					message: `yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
				});
			}
			return rawBody;
		});

		/* ------------------------------------------------------------------ */
		/* Reads                                                               */
		/* ------------------------------------------------------------------ */

		const getPost = Effect.fn("Pano.getPost")(function* (postId: string) {
			const meta = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: postId, deletedAt: {isNull: true}},
				}),
			);
			if (!meta) return null;
			return rowToPostPage(meta);
		});

		const listPostsConnection = Effect.fn("Pano.listPostsConnection")(function* (
			opts: {sort?: PostSort; first?: number; after?: string | null; host?: string | null} = {},
		) {
			const sort = opts.sort ?? "hot";
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;
			const host = opts.host ?? null;

			const baseConditions = [isNull(schema.postSummary.deletedAt)];
			if (host) baseConditions.push(eq(schema.postSummary.host, host));

			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.postSummary)
					.where(and(...baseConditions))
					.get()
					.then((r) => r?.n ?? 0),
			);

			let cursorRow: {
				id: string;
				score: number;
				hotScore: number;
				commentCount: number;
				createdAt: Date | null;
			} | null = null;
			if (after) {
				cursorRow =
					(yield* run((db) =>
						db
							.select({
								id: schema.postSummary.id,
								score: schema.postSummary.score,
								hotScore: schema.postSummary.hotScore,
								commentCount: schema.postSummary.commentCount,
								createdAt: schema.postSummary.createdAt,
							})
							.from(schema.postSummary)
							.where(eq(schema.postSummary.id, after))
							.get(),
					)) ?? null;
				// Cursor miss → empty page (the one shared cursor-miss semantic).
				if (!cursorRow) {
					return {
						rows: [],
						hasNextPage: false,
						endCursor: null,
						totalCount,
					} satisfies PostConnectionPage;
				}
			}

			// The sort's lead column (all descending) followed by the `id` desc
			// tiebreaker. `new` orders by id alone.
			const leadColumn =
				sort === "top"
					? {column: schema.postSummary.score, value: cursorRow?.score}
					: sort === "discuss"
						? {column: schema.postSummary.commentCount, value: cursorRow?.commentCount}
						: sort === "new"
							? null
							: {column: schema.postSummary.hotScore, value: cursorRow?.hotScore};

			const cursorPredicate = keysetAfter([
				...(leadColumn
					? [{column: leadColumn.column, dir: "desc" as const, value: leadColumn.value ?? null}]
					: []),
				{column: schema.postSummary.id, dir: "desc", value: cursorRow?.id ?? null},
			]);

			const whereExpr = cursorPredicate
				? and(...baseConditions, cursorPredicate)
				: and(...baseConditions);

			const orderBy =
				sort === "new"
					? [desc(schema.postSummary.id)]
					: sort === "top"
						? [desc(schema.postSummary.score), desc(schema.postSummary.id)]
						: sort === "discuss"
							? [desc(schema.postSummary.commentCount), desc(schema.postSummary.id)]
							: [desc(schema.postSummary.hotScore), desc(schema.postSummary.id)];

			const fetched = yield* run((db) =>
				db
					.select({
						id: schema.postSummary.id,
						slug: schema.postSummary.slug,
						title: schema.postSummary.title,
						url: schema.postSummary.url,
						host: schema.postSummary.host,
						bodyExcerpt: schema.postSummary.bodyExcerpt,
						authorId: schema.postSummary.authorId,
						authorName: schema.postSummary.authorName,
						score: schema.postSummary.score,
						commentCount: schema.postSummary.commentCount,
						createdAt: schema.postSummary.createdAt,
						tags: schema.postSummary.tags,
					})
					.from(schema.postSummary)
					.where(whereExpr)
					.orderBy(...orderBy)
					.limit(first + 1),
			);

			const page = forwardPage(
				fetched,
				first,
				(r: PostSummaryRow) => r.id,
				(r) => ({
					id: r.id,
					slug: r.slug,
					title: r.title,
					url: r.url,
					host: r.host,
					body: r.bodyExcerpt,
					author: r.authorName,
					authorId: r.authorId,
					score: r.score,
					commentCount: r.commentCount,
					createdAt: r.createdAt ?? new Date(0),
					tags: parseTags(r.tags),
				}),
			);

			return {...page, totalCount} satisfies PostConnectionPage;
		});

		/**
		 * DB-keyset page over a post's comments. Pages forward in
		 * chronological-asc order `(created_at asc, id asc)`; cursor is the
		 * comment id, fetched as a bounded `WHERE … LIMIT first+1`. The
		 * reply-aware placeholder pass (`rowToCommentRow`) still applies, so the
		 * wire shape matches the other comment reads.
		 */
		const listCommentsKeyset = Effect.fn("Pano.listCommentsKeyset")(function* (
			postId: string,
			opts: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 50, 200));
			const after = opts.after ?? null;
			const viewerId = opts.viewerId ?? null;

			const baseWhere = eq(schema.commentView.postId, postId);
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.commentView)
					.where(baseWhere)
					.get()
					.then((r) => r?.n ?? 0),
			);

			// Resolve the cursor row's (created_at, id) tuple so the keyset
			// predicate selects rows strictly after it in `(created_at asc, id
			// asc)` order. An `after` that doesn't resolve is a cursor miss →
			// empty page (the one cursor-miss semantic shared by all five keyset
			// methods).
			let cursorRow: {createdAt: Date | null} | null = null;
			if (after) {
				cursorRow =
					(yield* run((db) =>
						db
							.select({createdAt: schema.commentView.createdAt})
							.from(schema.commentView)
							.where(eq(schema.commentView.id, after))
							.get(),
					)) ?? null;
				if (!cursorRow) {
					return {
						rows: [],
						hasNextPage: false,
						endCursor: null,
						totalCount,
					} satisfies CommentConnectionPage;
				}
			}

			const cursorPredicate = keysetAfter([
				{column: schema.commentView.createdAt, dir: "asc", value: cursorRow?.createdAt ?? null},
				{column: schema.commentView.id, dir: "asc", value: after},
			]);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentView)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(asc(schema.commentView.createdAt), asc(schema.commentView.id))
					.limit(first + 1),
			);

			const voted = yield* voteSvc.readMine(
				viewerId,
				"comment",
				fetched.slice(0, first).map((c) => c.id),
			);
			const page = forwardPage(
				fetched,
				first,
				(r: CommentRow) => r.id,
				(c) => {
					const base = rowToCommentRow(c);
					return {...base, myVote: viewerId ? (voted.has(c.id) ? 1 : null) : null};
				},
			);

			return {...page, totalCount} satisfies CommentConnectionPage;
		});

		const getPostsByIds = Effect.fn("Pano.getPostsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {viewerId?: string | null | undefined} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.postSummary)
					.where(
						and(inArray(schema.postSummary.id, [...ids]), isNull(schema.postSummary.deletedAt)),
					),
			);
			const voted = yield* voteSvc.readMine(
				viewerId,
				"post",
				fetched.map((p) => p.id),
			);
			return fetched.map(
				(row): PostSummaryRow => ({
					id: row.id,
					slug: row.slug,
					title: row.title,
					url: row.url,
					host: row.host,
					body: row.bodyExcerpt && row.bodyExcerpt.length > 0 ? row.bodyExcerpt : null,
					author: row.authorName,
					authorId: row.authorId,
					score: row.score,
					commentCount: row.commentCount,
					createdAt: row.createdAt ?? new Date(0),
					updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
					tags: parseTags(row.tags),
					myVote: viewerId ? (voted.has(row.id) ? 1 : null) : null,
				}),
			);
		});

		const getCommentsByIds = Effect.fn("Pano.getCommentsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {viewerId?: string | null | undefined} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentView)
					.where(inArray(schema.commentView.id, [...ids])),
			);
			const voted = yield* voteSvc.readMine(
				viewerId,
				"comment",
				fetched.map((c) => c.id),
			);
			return fetched.map((c): CommentRow => {
				const base = rowToCommentRow(c);
				return {...base, myVote: viewerId ? (voted.has(c.id) ? 1 : null) : null};
			});
		});

		const lookupCommentPostId = Effect.fn("Pano.lookupCommentPostId")(function* (
			commentId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({postId: schema.commentView.postId})
					.from(schema.commentView)
					.where(eq(schema.commentView.id, commentId))
					.limit(1),
			);
			return rows[0]?.postId ?? null;
		});

		/* ------------------------------------------------------------------ */
		/* Post mutations                                                      */
		/* ------------------------------------------------------------------ */

		const submitPost = Effect.fn("Pano.submitPost")(function* (input: SubmitPostInput) {
			const title = yield* validatePostTitle(input.title ?? "");
			const body = yield* validatePostBody(input.body ?? "");

			let host: string | null = null;
			let urlNormalized: string | null = null;
			if (input.url != null && input.url.length > 0) {
				const parsed = yield* Effect.try({
					try: () => new URL(input.url as string),
					catch: () =>
						new UrlInvalid({
							message: "URL geçersiz",
						}),
				});
				urlNormalized = parsed.toString();
				host = parsed.host;
			}

			if (!input.tags || input.tags.length === 0) {
				return yield* new TagsRequired({
					message: "en az bir etiket seç",
				});
			}
			const allowed = new Set<string>(ALLOWED_POST_TAG_KINDS);
			const normalizedTags: PostTagRow[] = [];
			const seenKinds = new Set<string>();
			for (const t of input.tags) {
				const kind = (t.kind ?? "").trim();
				if (!allowed.has(kind)) {
					return yield* new TagInvalid({
						message: `geçersiz etiket: ${kind || "(boş)"}`,
					});
				}
				if (seenKinds.has(kind)) continue;
				seenKinds.add(kind);
				normalizedTags.push({kind, label: t.label?.trim() || kind});
			}

			const postId = id("post");
			const now = new Date();
			const hotScore = computeHotScore(0, now.getTime(), now.getTime());
			const bodyExcerpt = body ? excerpt(body) : null;
			const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

			yield* run((db) =>
				db.insert(schema.postSummary).values({
					id: postId,
					slug: null,
					title,
					url: urlNormalized,
					host,
					body: body ?? "",
					bodyExcerpt: bodyExcerpt ?? "",
					authorId: input.authorId,
					authorName: input.authorName,
					tags: tagsCsv,
					score: 0,
					commentCount: 0,
					hotScore,
					createdAt: now,
					updatedAt: now,
					lastActivityAt: now,
					deletedAt: null,
					lastEventId: "",
				}),
			);

			yield* recomputePanoStats(now);

			return {
				postId,
				title,
				url: urlNormalized,
				host,
				body,
				authorId: input.authorId,
				authorName: input.authorName,
				score: 0,
				commentCount: 0,
				tags: normalizedTags,
				createdAt: now,
			} satisfies SubmitPostResult;
		});

		const editPost = Effect.fn("Pano.editPost")(function* (input: EditPostInput) {
			const meta = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: input.postId, deletedAt: {isNull: true}},
				}),
			);
			if (!meta) {
				return yield* new PostNotFound({
					postId: input.postId,
					message: `post ${input.postId} not found`,
				});
			}
			if (meta.authorId !== input.actorId) {
				return yield* new UnauthorizedPostMutation({
					postId: input.postId,
					message: `not authorized to mutate post ${input.postId}`,
				});
			}

			const hasTitle = input.title !== undefined;
			const hasBody = input.body !== undefined;
			if (!hasTitle && !hasBody) {
				return yield* new TitleRequired({
					message: "başlık veya metin gerekli",
				});
			}

			let nextTitle = meta.title;
			if (hasTitle) nextTitle = yield* validatePostTitle(input.title ?? "");

			let nextBody: string | null = meta.body && meta.body.length > 0 ? meta.body : null;
			let nextBodyStored = meta.body;
			let nextBodyExcerpt = meta.bodyExcerpt;
			if (hasBody) {
				const raw = input.body ?? "";
				nextBody = yield* validatePostBody(raw);
				nextBodyStored = raw;
				nextBodyExcerpt = nextBody ? excerpt(nextBody) : "";
			}

			const now = new Date();
			const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now.getTime();
			const hotScore = computeHotScore(meta.score, createdAtMs, now.getTime());

			yield* run((db) =>
				db
					.update(schema.postSummary)
					.set({
						title: nextTitle,
						body: nextBodyStored,
						bodyExcerpt: nextBodyExcerpt,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postSummary.id, input.postId)),
			);

			return {
				postId: input.postId,
				title: nextTitle,
				url: meta.url,
				host: meta.host,
				body: nextBody,
				authorId: meta.authorId,
				authorName: meta.authorName,
				score: meta.score,
				hotScore,
				commentCount: meta.commentCount,
				tags: parseTags(meta.tags),
				createdAt: meta.createdAt ?? new Date(createdAtMs),
				updatedAt: now,
			} satisfies EditPostResult;
		});

		/**
		 * HARD delete: removes the summary row, wipes the vote tables, and
		 * reverses the author's karma. This diverges from `Sozluk.deleteDefinition`
		 * (soft delete, karma kept) — a deliberate, known inconsistency pending
		 * `.decisions/0024-delete-semantics-and-karma.md`. Read that ADR before
		 * "fixing" one path to match the other.
		 */
		const deletePost = Effect.fn("Pano.deletePost")(function* (input: DeletePostInput) {
			const meta = yield* run((db) => db.query.postSummary.findFirst({where: {id: input.postId}}));
			if (!meta) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}
			if (meta.authorId !== input.actorId) {
				return yield* new UnauthorizedPostMutation({
					postId: input.postId,
					message: `not authorized to mutate post ${input.postId}`,
				});
			}
			if (meta.deletedAt) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}

			const now = new Date();
			const priorScore = meta.score;

			// One batch carries every delete-time mutation: optional karma
			// decrement leads (only when there were votes to retract), then the
			// vote-table wipe (`post_vote`), then the cross-product mirror wipe
			// (`user_vote`), then the `post_summary` row removal itself.
			// Matches the atomic-mutation contract enforced by the Vote service
			// so a worker crash mid-delete can't leave karma debited against a
			// surviving post or orphan vote rows.
			//
			// `recomputePanoStats` stays outside the batch — it's a recomputable
			// cache refresh derived from current state, not part of the atomic
			// mutation.
			if (priorScore > 0) {
				yield* batch((db) => [
					db
						.update(schema.userProfile)
						.set({
							totalKarma: sql`MAX(0, ${schema.userProfile.totalKarma} - ${priorScore})`,
							updatedAt: now,
						})
						.where(eq(schema.userProfile.userId, meta.authorId)),
					db.delete(schema.postVote).where(eq(schema.postVote.postId, input.postId)),
					db
						.delete(schema.userVote)
						.where(
							and(
								eq(schema.userVote.targetKind, "post"),
								eq(schema.userVote.targetId, input.postId),
							),
						),
					db.delete(schema.postSummary).where(eq(schema.postSummary.id, input.postId)),
				]);
			} else {
				yield* batch((db) => [
					db.delete(schema.postVote).where(eq(schema.postVote.postId, input.postId)),
					db
						.delete(schema.userVote)
						.where(
							and(
								eq(schema.userVote.targetKind, "post"),
								eq(schema.userVote.targetId, input.postId),
							),
						),
					db.delete(schema.postSummary).where(eq(schema.postSummary.id, input.postId)),
				]);
			}

			yield* recomputePanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		/**
		 * Shared body for `voteOnPost` / `retractPostVote`. Delegates to the
		 * shared `Vote.cast` for the atomic batch (vote insert/delete,
		 * score-cache update, `user_vote` mirror, karma bump). Translates
		 * `VoteTargetNotFound` from the Vote service into `PostNotFound` so the
		 * resolver codec keeps producing `POST_NOT_FOUND`.
		 */
		const applyPostVote = Effect.fn("Pano.applyPostVote")(function* (
			input: VoteOnPostInput,
			isVote: boolean,
		) {
			const meta = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: input.postId, deletedAt: {isNull: true}},
				}),
			);
			if (!meta) {
				return yield* new PostNotFound({
					postId: input.postId,
					message: `post ${input.postId} not found`,
				});
			}

			const voteResult = yield* voteSvc
				.cast({
					userId: input.voterId,
					targetKind: "post",
					targetId: input.postId,
					value: isVote ? 1 : null,
				})
				.pipe(
					Effect.catchTag("vote/VoteTargetNotFound", (_e: VoteTargetNotFound) =>
						Effect.fail(
							new PostNotFound({
								postId: input.postId,
								message: `post ${input.postId} not found`,
							}),
						),
					),
				);

			const now = new Date();
			// Vote.cast wrote post_summary.score + hot_score inside its batch.
			// Re-read so the response surfaces the converged values.
			const refreshed = voteResult.changed
				? yield* run((db) => db.query.postSummary.findFirst({where: {id: input.postId}}))
				: meta;
			const score = refreshed?.score ?? voteResult.score;
			const hotScore = refreshed?.hotScore ?? meta.hotScore;

			return {
				postId: input.postId,
				title: meta.title,
				url: meta.url,
				host: meta.host,
				body: meta.body && meta.body.length > 0 ? meta.body : null,
				authorId: meta.authorId,
				authorName: meta.authorName,
				score,
				hotScore,
				commentCount: meta.commentCount,
				tags: parseTags(meta.tags),
				createdAt: meta.createdAt ?? now,
				myVote: voteResult.myVote,
				changed: voteResult.changed,
			} satisfies VoteOnPostResult;
		});

		const voteOnPost = Effect.fn("Pano.voteOnPost")(function* (input: VoteOnPostInput) {
			return yield* applyPostVote(input, true);
		});

		const retractPostVote = Effect.fn("Pano.retractPostVote")(function* (input: VoteOnPostInput) {
			return yield* applyPostVote(input, false);
		});

		/* ------------------------------------------------------------------ */
		/* Comment mutations                                                   */
		/* ------------------------------------------------------------------ */

		const addComment = Effect.fn("Pano.addComment")(function* (input: AddCommentInput) {
			const rawBody = yield* validateCommentBody(input.body);

			const post = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: input.postId, deletedAt: {isNull: true}},
				}),
			);
			if (!post) {
				return yield* new PostNotFound({
					postId: input.postId,
					message: `post ${input.postId} not found`,
				});
			}

			const parentId = input.parentId ?? null;
			if (parentId !== null) {
				const parent = yield* run((db) =>
					db.query.commentView.findFirst({
						where: {id: parentId, postId: input.postId, deletedAt: {isNull: true}},
					}),
				);
				if (!parent) {
					return yield* new ParentCommentNotFound({
						message: "yanıtlanan yorum bulunamadı",
					});
				}
			}

			const now = new Date();
			const commentId = id("comm");
			const bodyExcerpt = excerpt(rawBody);

			yield* run((db) =>
				db.insert(schema.commentView).values({
					id: commentId,
					authorId: input.authorId,
					authorName: input.authorName,
					postId: input.postId,
					postTitle: post.title,
					parentId,
					body: rawBody,
					bodyExcerpt,
					score: 0,
					createdAt: now,
					updatedAt: now,
					deletedAt: null,
					lastEventId: "",
				}),
			);

			const newCommentCount = post.commentCount + 1;
			const hotScore = computeHotScore(
				post.score,
				(post.createdAt ?? now).getTime(),
				now.getTime(),
			);

			yield* run((db) =>
				db
					.update(schema.postSummary)
					.set({
						commentCount: newCommentCount,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postSummary.id, input.postId)),
			);

			yield* recomputePanoStats(now);

			return {
				commentId,
				postId: input.postId,
				parentId,
				authorId: input.authorId,
				authorName: input.authorName,
				body: rawBody,
				score: 0,
				commentCount: newCommentCount,
				createdAt: now,
			} satisfies AddCommentResult;
		});

		const editComment = Effect.fn("Pano.editComment")(function* (input: EditCommentInput) {
			const rawBody = yield* validateCommentBody(input.body);

			const row = yield* run((db) =>
				db.query.commentView.findFirst({
					where: {id: input.commentId, deletedAt: {isNull: true}},
				}),
			);
			if (!row) {
				return yield* new CommentNotFound({
					commentId: input.commentId,
					message: `comment ${input.commentId} not found`,
				});
			}
			if (row.authorId !== input.actorId) {
				return yield* new UnauthorizedCommentMutation({
					commentId: input.commentId,
					message: `not authorized to mutate comment ${input.commentId}`,
				});
			}

			const now = new Date();
			const bodyExcerpt = excerpt(rawBody);

			yield* run((db) =>
				db
					.update(schema.commentView)
					.set({body: rawBody, bodyExcerpt, updatedAt: now})
					.where(eq(schema.commentView.id, input.commentId)),
			);

			return {
				commentId: input.commentId,
				postId: row.postId,
				parentId: row.parentId,
				authorId: row.authorId,
				authorName: row.authorName,
				body: rawBody,
				score: row.score,
				createdAt: row.createdAt ?? now,
				updatedAt: now,
			} satisfies EditCommentResult;
		});

		const deleteComment = Effect.fn("Pano.deleteComment")(function* (input: DeleteCommentInput) {
			const row = yield* run((db) =>
				db.query.commentView.findFirst({where: {id: input.commentId}}),
			);
			if (!row) {
				return yield* new CommentNotFound({
					commentId: input.commentId,
					message: `comment ${input.commentId} not found`,
				});
			}
			if (row.authorId !== input.actorId) {
				return yield* new UnauthorizedCommentMutation({
					commentId: input.commentId,
					message: `not authorized to mutate comment ${input.commentId}`,
				});
			}
			if (row.deletedAt) {
				return {
					commentId: input.commentId,
					deleted: false,
					hasReplies: true,
					placeholder: rowToCommentRow(row),
				} satisfies DeleteCommentResult;
			}

			const childCountRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.commentView)
					.where(
						and(
							eq(schema.commentView.parentId, input.commentId),
							isNull(schema.commentView.deletedAt),
						),
					)
					.get(),
			);
			const hasReplies = (childCountRow?.n ?? 0) > 0;

			const now = new Date();
			const priorScore = row.score;

			// One batch carries every delete-time mutation: optional karma
			// decrement leads, then the vote-table wipe (`comment_vote`), then
			// the cross-product mirror wipe (`user_vote`), then the
			// branch-dependent terminal — UPDATE for parent-with-replies
			// (soft-delete) or DELETE for leaves (hard-delete).
			//
			// The post `commentCount` decrement and `recomputePanoStats` stay
			// outside the batch — both are recomputable cache refreshes derived
			// from current state, not part of the atomic mutation.
			const commentId = input.commentId;
			const buildTerminal = (db: DrizzleDb) =>
				hasReplies
					? db
							.update(schema.commentView)
							.set({
								body: "",
								bodyExcerpt: SILINDI_PLACEHOLDER,
								score: 0,
								deletedAt: now,
								updatedAt: now,
							})
							.where(eq(schema.commentView.id, commentId))
					: db.delete(schema.commentView).where(eq(schema.commentView.id, commentId));

			if (priorScore > 0) {
				yield* batch((db) => [
					db
						.update(schema.userProfile)
						.set({
							totalKarma: sql`MAX(0, ${schema.userProfile.totalKarma} - ${priorScore})`,
							updatedAt: now,
						})
						.where(eq(schema.userProfile.userId, row.authorId)),
					db.delete(schema.commentVote).where(eq(schema.commentVote.commentId, commentId)),
					db
						.delete(schema.userVote)
						.where(
							and(
								eq(schema.userVote.targetKind, "comment"),
								eq(schema.userVote.targetId, commentId),
							),
						),
					buildTerminal(db),
				]);
			} else {
				yield* batch((db) => [
					db.delete(schema.commentVote).where(eq(schema.commentVote.commentId, commentId)),
					db
						.delete(schema.userVote)
						.where(
							and(
								eq(schema.userVote.targetKind, "comment"),
								eq(schema.userVote.targetId, commentId),
							),
						),
					buildTerminal(db),
				]);
			}

			const post = yield* run((db) => db.query.postSummary.findFirst({where: {id: row.postId}}));
			if (post) {
				const newCommentCount = Math.max(0, post.commentCount - 1);
				const hotScore = computeHotScore(
					post.score,
					(post.createdAt ?? now).getTime(),
					now.getTime(),
				);
				yield* run((db) =>
					db
						.update(schema.postSummary)
						.set({
							commentCount: newCommentCount,
							hotScore,
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postSummary.id, row.postId)),
				);
			}

			yield* recomputePanoStats(now);

			const placeholder: CommentRow | null = hasReplies
				? {
						id: input.commentId,
						parentId: row.parentId,
						author: "",
						authorId: "",
						body: SILINDI_PLACEHOLDER,
						score: 0,
						createdAt: row.createdAt ?? new Date(0),
						updatedAt: now,
						deletedAt: now,
					}
				: null;

			return {
				commentId: input.commentId,
				deleted: true,
				hasReplies,
				placeholder,
			} satisfies DeleteCommentResult;
		});

		/**
		 * Shared body for `voteOnComment` / `retractCommentVote`. Delegates to
		 * `Vote.cast`. Translates `VoteTargetNotFound` from Vote into
		 * `CommentNotFound`.
		 */
		const applyCommentVote = Effect.fn("Pano.applyCommentVote")(function* (
			input: VoteOnCommentInput,
			isVote: boolean,
		) {
			const row = yield* run((db) =>
				db.query.commentView.findFirst({
					where: {id: input.commentId, deletedAt: {isNull: true}},
				}),
			);
			if (!row) {
				return yield* new CommentNotFound({
					commentId: input.commentId,
					message: `comment ${input.commentId} not found`,
				});
			}

			const voteResult = yield* voteSvc
				.cast({
					userId: input.voterId,
					targetKind: "comment",
					targetId: input.commentId,
					value: isVote ? 1 : null,
				})
				.pipe(
					Effect.catchTag("vote/VoteTargetNotFound", (_e: VoteTargetNotFound) =>
						Effect.fail(
							new CommentNotFound({
								commentId: input.commentId,
								message: `comment ${input.commentId} not found`,
							}),
						),
					),
				);

			const now = new Date();
			return {
				commentId: input.commentId,
				postId: row.postId,
				parentId: row.parentId,
				authorId: row.authorId,
				authorName: row.authorName,
				body: row.body,
				score: voteResult.score,
				createdAt: row.createdAt ?? now,
				myVote: voteResult.myVote,
				changed: voteResult.changed,
			} satisfies VoteOnCommentResult;
		});

		const voteOnComment = Effect.fn("Pano.voteOnComment")(function* (input: VoteOnCommentInput) {
			return yield* applyCommentVote(input, true);
		});

		const retractCommentVote = Effect.fn("Pano.retractCommentVote")(function* (
			input: VoteOnCommentInput,
		) {
			return yield* applyCommentVote(input, false);
		});

		return {
			getPost,
			listPostsConnection,
			listCommentsKeyset,
			getPostsByIds,
			getCommentsByIds,
			lookupCommentPostId,
			submitPost,
			editPost,
			deletePost,
			voteOnPost,
			retractPostVote,
			addComment,
			editComment,
			deleteComment,
			voteOnComment,
			retractCommentVote,
		};
	}),
);
