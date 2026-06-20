/**
 * Pano — the link aggregator / discussion feature service. Resolver-facing
 * surface for post + comment CRUD, vote delegation, and connection-shaped
 * pagination.
 *
 * Vote mutations delegate to `Vote.cast` rather than reimplementing the batched
 * vote / karma / score-cache logic; the Pano-side wrappers re-load the target
 * row for the canonical resolver shape and translate `VoteTargetNotFound` into
 * `PostNotFound` / `CommentNotFound` so the resolver codec keeps producing
 * `POST_NOT_FOUND` / `COMMENT_NOT_FOUND`.
 *
 * Validation lives in the service methods, not resolvers (ADR 0013).
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {removePostSearch, syncPostSearch} from "../search/fts-sync.ts";
import {excerpt as excerptText} from "../text/index.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
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

export const POST_TITLE_MAX = 200;
export const POST_BODY_MAX = 10_000;
export const COMMENT_BODY_MAX = 5_000;

const POST_EXCERPT_LEN = 280; // tweet-sized

const excerpt = (body: string): string => excerptText(body, POST_EXCERPT_LEN);

/** Fixed tag enum, stored on `post_summary.tags` as comma-separated values. */
export const ALLOWED_POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

export type AllowedPostTagKind = (typeof ALLOWED_POST_TAG_KINDS)[number];

/**
 * Body rendered for a soft-deleted comment that still has non-deleted replies
 * (parent-with-replies path). Leaf-deleted comments are removed entirely, so
 * the placeholder never appears for them.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

/**
 * Label map for the fixed tag enum: the Turkish source-of-truth kinds plus
 * legacy English aliases that may exist in seed data.
 */
const TAG_LABELS: Record<string, string> = {
	göster: "göster",
	tartışma: "tartışma",
	soru: "soru",
	söylenme: "söylenme",
	meta: "meta",
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
};

/** Falls back to the raw kind so unknown tags still render. */
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
	/** Viewer's upvote flag; `undefined` (unset) for reads that don't request it. */
	myVote?: number | null;
	/** Viewer's bookmark presence; `undefined` (unset) for reads that don't request it. */
	isSaved?: boolean | null;
	/** Draft (taslak) marker; stamped from `post_summary.is_draft` (null = published). */
	isDraft?: boolean | null;
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
	/** Viewer's upvote flag; `undefined` (unset) for reads that don't request it. */
	myVote?: number | null;
}

export interface CommentConnectionPage {
	rows: CommentRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

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

export interface SaveDraftInput {
	authorId: string;
	authorName: string;
	title?: string | undefined;
	url?: string | undefined;
	body?: string | undefined;
	tags?: ReadonlyArray<{kind: string; label?: string | undefined}> | undefined;
}

/** A draft re-resolves like a fresh post; `isDraft` rides the wire as `true`. */
export interface SaveDraftResult extends SubmitPostResult {
	isDraft: true;
}

export interface DiscardDraftInput {
	authorId: string;
}

export interface DiscardDraftResult {
	postId: string | null;
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

export class Pano extends Context.Service<
	Pano,
	{
		readonly getPost: (postId: string) => Effect.Effect<PostPage | null>;

		readonly listPostsConnection: (opts?: {
			sort?: PostSort;
			first?: number;
			after?: string | null;
			host?: string | null;
		}) => Effect.Effect<PostConnectionPage>;

		/**
		 * Keyset page over a post's comments, `(created_at asc, id asc)` (ADR 0019).
		 * `viewerId` stamps `myVote` for the whole page in one `user_vote` read.
		 */
		readonly listCommentsKeyset: (
			postId: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			},
		) => Effect.Effect<CommentConnectionPage>;

		/** Post source `byIds` — batched read avoiding the relation N+1. */
		readonly getPostsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<ReadonlyArray<PostSummaryRow>>;

		/** Comment source `byIds` — batched read avoiding the relation N+1. */
		readonly getCommentsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<ReadonlyArray<CommentRow>>;

		/** Resolve a comment's parent post id (for re-resolving on delete). */
		readonly lookupCommentPostId: (commentId: string) => Effect.Effect<string | null>;

		readonly submitPost: (
			input: SubmitPostInput,
		) => Effect.Effect<SubmitPostResult, PostValidation>;

		readonly saveDraft: (input: SaveDraftInput) => Effect.Effect<SaveDraftResult, PostValidation>;

		readonly discardDraft: (input: DiscardDraftInput) => Effect.Effect<DiscardDraftResult>;

		readonly editPost: (
			input: EditPostInput,
		) => Effect.Effect<EditPostResult, PostValidation | PostNotFound | UnauthorizedPostMutation>;

		readonly deletePost: (
			input: DeletePostInput,
		) => Effect.Effect<DeletePostResult, UnauthorizedPostMutation>;

		readonly voteOnPost: (input: VoteOnPostInput) => Effect.Effect<VoteOnPostResult, PostNotFound>;

		readonly retractPostVote: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound>;

		readonly addComment: (
			input: AddCommentInput,
		) => Effect.Effect<AddCommentResult, CommentValidation | PostNotFound>;

		readonly editComment: (
			input: EditCommentInput,
		) => Effect.Effect<
			EditCommentResult,
			CommentValidation | CommentNotFound | UnauthorizedCommentMutation
		>;

		readonly deleteComment: (
			input: DeleteCommentInput,
		) => Effect.Effect<DeleteCommentResult, CommentNotFound | UnauthorizedCommentMutation>;

		readonly voteOnComment: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound>;

		readonly retractCommentVote: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound>;
	}
>()("@kampus/pano/Pano") {}

export const PanoLive = Layer.effect(Pano)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call site dies on `DrizzleError`
		// (infra failures are defects — the domain-boundary rule), so public
		// signatures carry domain errors only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const voteSvc = yield* Vote;
		const bookmarkSvc = yield* Bookmark;

		/**
		 * HN-style hot score: `score / (hours_old + 2)^1.8`, scaled by 1000 and
		 * floored so the persisted column stays an integer (D1 indexes integers
		 * cheaper than floats; only the relative ordering matters).
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
		 * parent-with-replies case, rendered as the placeholder. Leaf-deleted
		 * rows are removed from `comment_view`, so they never reach this branch.
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

		/** Returns the normalized body (`null` for empty), or fails `PostValidation`. */
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

			// `is_draft IS NOT 1` excludes drafts from the public feed while keeping
			// null/0 rows (published) — drafts are private to their author (#746).
			const baseConditions = [
				isNull(schema.postSummary.deletedAt),
				sql`${schema.postSummary.isDraft} is not 1`,
			];
			if (host) baseConditions.push(eq(schema.postSummary.host, host));

			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.postSummary)
					.where(and(...baseConditions))
					.get()
					.then((r) => r?.n ?? 0),
			);

			type CursorRow = {
				id: string;
				score: number;
				hotScore: number;
				commentCount: number;
				createdAt: Date | null;
			};
			const resolvedRow = after
				? ((yield* run((db) =>
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
					)) ?? null)
				: null;
			const cursor = resolveCursor<CursorRow>(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies PostConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// Sort's lead column (all descending) + `id` desc tiebreaker; `new`
			// orders by id alone.
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

			// Resolve the (created_at) cursor tuple. The DB read is the port;
			// `resolveCursor` is the pure cursor-miss decision (see `listPostsConnection`).
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.commentView.createdAt})
							.from(schema.commentView)
							.where(eq(schema.commentView.id, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies CommentConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

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
			const ids2 = fetched.map((p) => p.id);
			const voted = yield* voteSvc.readMine(viewerId, "post", ids2);
			// `isSaved` rides the same batch as `myVote` — one `post_bookmark` read for
			// the whole page, stamped here as a scalar (no per-row resolver, no N+1).
			const saved = yield* bookmarkSvc.readMine(viewerId, ids2);
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
					isSaved: viewerId ? saved.has(row.id) : null,
					// A by-id read returns the author's own draft (read-your-writes); stamp
					// its marker so the re-resolved entity carries `isDraft: true`.
					isDraft: row.isDraft ?? null,
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

			// Dual-write the post's FTS row alongside the summary insert (ADR 0080).
			for (const stmt of syncPostSearch(postId, title)) {
				yield* run((db) => db.run(stmt));
			}

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

		// A draft is a partial post: the only gates are submit's length/sanity caps
		// (no required title/tags), so a half-filled form persists. One draft per
		// author is enforced by the partial unique index + this probe-then-upsert.
		const saveDraft = Effect.fn("Pano.saveDraft")(function* (input: SaveDraftInput) {
			const rawTitle = (input.title ?? "").trim();
			if (rawTitle.length > POST_TITLE_MAX) {
				return yield* new TitleTooLong({
					message: `başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
				});
			}
			const body = yield* validatePostBody(input.body ?? "");

			let host: string | null = null;
			let urlNormalized: string | null = null;
			if (input.url != null && input.url.length > 0) {
				const parsed = yield* Effect.try({
					try: () => new URL(input.url as string),
					catch: () => new UrlInvalid({message: "URL geçersiz"}),
				});
				urlNormalized = parsed.toString();
				host = parsed.host;
			}

			const allowed = new Set<string>(ALLOWED_POST_TAG_KINDS);
			const normalizedTags: PostTagRow[] = [];
			const seenKinds = new Set<string>();
			for (const t of input.tags ?? []) {
				const kind = (t.kind ?? "").trim();
				if (kind.length === 0) continue;
				if (!allowed.has(kind)) {
					return yield* new TagInvalid({message: `geçersiz etiket: ${kind}`});
				}
				if (seenKinds.has(kind)) continue;
				seenKinds.add(kind);
				normalizedTags.push({kind, label: t.label?.trim() || kind});
			}

			const now = new Date();
			const bodyExcerpt = body ? excerpt(body) : "";
			const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

			const existing = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {authorId: input.authorId, isDraft: true},
					columns: {id: true, createdAt: true},
				}),
			);

			const postId = existing?.id ?? id("post");
			const createdAt = existing?.createdAt ?? now;
			const hotScore = computeHotScore(0, createdAt.getTime(), now.getTime());

			if (existing) {
				yield* run((db) =>
					db
						.update(schema.postSummary)
						.set({
							title: rawTitle,
							url: urlNormalized,
							host,
							body: body ?? "",
							bodyExcerpt,
							authorName: input.authorName,
							tags: tagsCsv,
							hotScore,
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postSummary.id, postId)),
				);
			} else {
				yield* run((db) =>
					db.insert(schema.postSummary).values({
						id: postId,
						slug: null,
						title: rawTitle,
						url: urlNormalized,
						host,
						body: body ?? "",
						bodyExcerpt,
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
						isDraft: true,
						lastEventId: "",
					}),
				);
			}

			// A draft is never in the public FTS table (it never lists publicly), so
			// no `syncPostSearch` dual-write and no `recomputePanoStats` — both are
			// public-surface bookkeeping that a private draft must not touch.

			return {
				postId,
				title: rawTitle,
				url: urlNormalized,
				host,
				body,
				authorId: input.authorId,
				authorName: input.authorName,
				score: 0,
				commentCount: 0,
				tags: normalizedTags,
				createdAt,
				isDraft: true,
			} satisfies SaveDraftResult;
		});

		const discardDraft = Effect.fn("Pano.discardDraft")(function* (input: DiscardDraftInput) {
			const existing = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {authorId: input.authorId, isDraft: true},
					columns: {id: true},
				}),
			);
			if (!existing) return {postId: null} satisfies DiscardDraftResult;
			yield* run((db) =>
				db
					.delete(schema.postSummary)
					.where(and(eq(schema.postSummary.authorId, input.authorId), eq(schema.postSummary.isDraft, true))),
			);
			return {postId: existing.id} satisfies DiscardDraftResult;
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

			// Re-sync the post's FTS row when the title changed (ADR 0080). The body
			// is out of v1 scope, so a body-only edit leaves the FTS row untouched.
			if (hasTitle) {
				for (const stmt of syncPostSearch(input.postId, nextTitle)) {
					yield* run((db) => db.run(stmt));
				}
			}

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
		 * HARD delete: removes the summary row, wipes the vote tables, reverses
		 * karma. Deliberately diverges from `Sozluk.deleteDefinition` (soft
		 * delete, karma kept) — see `.decisions/0024-delete-semantics-and-karma.md`
		 * before "fixing" one path to match the other.
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

			// One batch for every delete-time mutation (karma decrement, vote-table
			// wipe, `user_vote` mirror wipe, `post_summary` removal) so a crash
			// mid-delete can't leave karma debited against a surviving post or
			// orphan vote rows. `recomputePanoStats` stays outside — it's a
			// recomputable cache refresh, not part of the atomic mutation.
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

			// Drop the post's FTS row — a hard-deleted post must leave search (ADR 0080).
			yield* run((db) => db.run(removePostSearch(input.postId)));

			yield* recomputePanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		/**
		 * Shared body for `voteOnPost` / `retractPostVote`. Delegates to
		 * `Vote.cast` and translates `VoteTargetNotFound` into `PostNotFound`.
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
			// Vote.cast wrote score + hot_score inside its batch; re-read for the
			// converged values.
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

			// One batch for every delete-time mutation: karma decrement, vote-table
			// wipe, `user_vote` mirror wipe, then the branch-dependent terminal —
			// UPDATE (soft-delete) for parent-with-replies, DELETE (hard) for
			// leaves. The `commentCount` decrement and `recomputePanoStats` stay
			// outside — recomputable cache refreshes, not the atomic mutation.
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
			saveDraft,
			discardDraft,
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
