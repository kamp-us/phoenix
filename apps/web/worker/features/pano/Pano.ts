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
import {
	isPostTagKind,
	POST_TAG_KINDS,
	type PostTagKind,
	tagLabel,
} from "../../../src/lib/panoTags.ts";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {computeHotScore} from "../../db/hotScore.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import * as Lifecycle from "../lifecycle/EntityLifecycle.ts";
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

// The tag enum + label aliases have a single typed home in `src/lib/panoTags.ts`,
// cross-included by the worker tsconfig (#1030); re-exported here so the long-lived
// server-side names (consumed by `sources.ts` etc.) keep resolving.
export {tagLabel};
export const ALLOWED_POST_TAG_KINDS = POST_TAG_KINDS;
export type AllowedPostTagKind = PostTagKind;

/**
 * Tombstone body the view layer renders for a `Removed` comment (ADR 0096 §5) —
 * not a body the delete path writes. The canonical body stays in the row for
 * restore + moderator review; `rowToCommentRow` substitutes this for display.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

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

/** Raw tag shape on submit/draft input — `label` is optional until normalized. */
export interface PostTagInput {
	kind: string;
	label?: string | undefined;
}

// Submit-validation lives here as exported pure functions (ADR 0013 for *where*
// validation belongs, ADR 0082 for *why* it's lifted off the service): each is
// wrong-or-right on its input with no DB, so the wire codes unit-test off-DB and
// the integration tier keeps only the real-DB-miss cases. `submitPost` /
// `saveDraft` / `addComment` / `editPost` / `editComment` call these at the same
// point they used to call the in-factory closures, so observable behavior + wire
// codes are unchanged.

/** Returns the normalized body (`null` for empty), or fails `PostBodyTooLong`. */
export const validatePostBody = Effect.fn("Pano.validatePostBody")(function* (rawBody: string) {
	if (rawBody.length > POST_BODY_MAX) {
		return yield* new PostBodyTooLong({
			message: `metin en fazla ${POST_BODY_MAX} karakter olabilir`,
		});
	}
	return rawBody.length === 0 ? null : rawBody;
});

export const validatePostTitle = Effect.fn("Pano.validatePostTitle")(function* (raw: string) {
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

/**
 * Draft title gate — `saveDraft` has no required title (a half-filled form
 * persists), only the length cap. Returns the trimmed title or fails
 * `TitleTooLong`.
 */
export const validateDraftTitle = Effect.fn("Pano.validateDraftTitle")(function* (raw: string) {
	const trimmed = raw.trim();
	if (trimmed.length > POST_TITLE_MAX) {
		return yield* new TitleTooLong({
			message: `başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
		});
	}
	return trimmed;
});

export const validateCommentBody = Effect.fn("Pano.validateCommentBody")(function* (
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

/**
 * Parse an optional submit/draft URL to its normalized form + host. An empty or
 * absent URL yields `{host: null, urlNormalized: null}`; a malformed one fails
 * `UrlInvalid`. Shared by `submitPost` and `saveDraft`.
 */
export const parseSubmitUrl = Effect.fn("Pano.parseSubmitUrl")(function* (
	url: string | null | undefined,
) {
	if (url == null || url.length === 0) {
		return {host: null, urlNormalized: null} as const;
	}
	const parsed = yield* Effect.try({
		try: () => new URL(url),
		catch: () => new UrlInvalid({message: "URL geçersiz"}),
	});
	return {host: parsed.host, urlNormalized: parsed.toString()} as const;
});

/**
 * `submitPost` tag normalization: at least one tag is required, every kind must
 * be in the fixed enum, duplicate kinds collapse. Fails `TagsRequired` /
 * `TagInvalid`.
 */
export const normalizeSubmitTags = Effect.fn("Pano.normalizeSubmitTags")(function* (
	tags: ReadonlyArray<PostTagInput> | null | undefined,
) {
	if (!tags || tags.length === 0) {
		return yield* new TagsRequired({
			message: "en az bir etiket seç",
		});
	}
	const normalizedTags: PostTagRow[] = [];
	const seenKinds = new Set<string>();
	for (const t of tags) {
		const kind = (t.kind ?? "").trim();
		if (!isPostTagKind(kind)) {
			return yield* new TagInvalid({
				message: `geçersiz etiket: ${kind || "(boş)"}`,
			});
		}
		if (seenKinds.has(kind)) continue;
		seenKinds.add(kind);
		normalizedTags.push({kind, label: t.label?.trim() || kind});
	}
	return normalizedTags;
});

/**
 * `saveDraft` tag normalization: tags are optional (empty kinds skipped, not
 * rejected), but a non-empty kind outside the fixed enum still fails
 * `TagInvalid`.
 */
export const normalizeDraftTags = Effect.fn("Pano.normalizeDraftTags")(function* (
	tags: ReadonlyArray<PostTagInput> | null | undefined,
) {
	const normalizedTags: PostTagRow[] = [];
	const seenKinds = new Set<string>();
	for (const t of tags ?? []) {
		const kind = (t.kind ?? "").trim();
		if (kind.length === 0) continue;
		if (!isPostTagKind(kind)) {
			return yield* new TagInvalid({message: `geçersiz etiket: ${kind}`});
		}
		if (seenKinds.has(kind)) continue;
		seenKinds.add(kind);
		normalizedTags.push({kind, label: t.label?.trim() || kind});
	}
	return normalizedTags;
});

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
	/** Viewer's upvote presence (`true` voted); `undefined`/`null` when not requested or anonymous. */
	myVote?: boolean | null;
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
	/** Viewer's upvote presence (`true` voted); `undefined`/`null` when not requested or anonymous. */
	myVote?: boolean | null;
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
	myVote: boolean;
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
	/** Why the post is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Lifecycle.RemovalReason;
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
	myVote: boolean;
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
	/** Why the comment is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Lifecycle.RemovalReason;
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

		/** Un-remove a `Removed` post (ADR 0096 §4); re-enters search, votes stay wiped. */
		readonly restorePost: (
			input: DeletePostInput,
		) => Effect.Effect<DeletePostResult, UnauthorizedPostMutation>;

		/**
		 * Moderator soft-delete (ADR 0098 §6) — the same 0096 substrate write as
		 * `deletePost`, gated on discharged moderator authority (NOT author ownership):
		 * `removed_by` is the resolver, reason `Moderated({reportId})`. A missing target
		 * is a no-op.
		 */
		readonly moderateRemovePost: (input: {
			postId: string;
			resolverId: string;
			reportId: string;
		}) => Effect.Effect<{removed: boolean}>;

		/** Moderator restore (ADR 0098 §3) — reopens the report at the resolve layer. */
		readonly moderateRestorePost: (input: {postId: string}) => Effect.Effect<{restored: boolean}>;

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

		/** Un-remove a `Removed` comment (ADR 0096 §4); votes stay wiped. */
		readonly restoreComment: (
			input: DeleteCommentInput,
		) => Effect.Effect<DeleteCommentResult, CommentNotFound | UnauthorizedCommentMutation>;

		/** Moderator soft-delete of a comment (ADR 0098 §6); reason `Moderated({reportId})`. */
		readonly moderateRemoveComment: (input: {
			commentId: string;
			resolverId: string;
			reportId: string;
		}) => Effect.Effect<{removed: boolean}>;

		/** Moderator restore of a comment (ADR 0098 §3) — reopens the report at the resolve layer. */
		readonly moderateRestoreComment: (input: {
			commentId: string;
		}) => Effect.Effect<{restored: boolean}>;

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

		// The tombstone is rendered HERE, from the lifecycle projection — not written
		// into the canonical body by the delete path (ADR 0096 §5). A `Removed`
		// comment surfaces as the `[silindi]` placeholder with author elided; its real
		// body stays in the row for restore + moderator review. `deletedAt` on the
		// wire-facing `CommentRow` is the removal timestamp (presentation contract).
		const rowToCommentRow = (row: typeof schema.commentRecord.$inferSelect): CommentRow => {
			const lifecycle = Lifecycle.fromColumns(row);
			if (Lifecycle.isRemoved(lifecycle)) {
				return {
					id: row.id,
					parentId: row.parentId,
					author: "",
					authorId: "",
					body: SILINDI_PLACEHOLDER,
					score: row.score,
					createdAt: row.createdAt ?? new Date(0),
					updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
					deletedAt: lifecycle.removedAt,
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
					.where(isNull(schema.postSummary.removedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalComments = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.commentRecord)
					.where(isNull(schema.commentRecord.removedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalAuthors = yield* run((db) =>
				db
					.run(
						sql`SELECT COUNT(DISTINCT author_id) as n FROM (
								SELECT author_id FROM post_summary WHERE removed_at IS NULL
								UNION
								SELECT author_id FROM comment_record WHERE removed_at IS NULL
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

		const getPost = Effect.fn("Pano.getPost")(function* (postId: string) {
			const meta = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: postId, removedAt: {isNull: true}},
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
				isNull(schema.postSummary.removedAt),
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

			// A removed comment stays in the thread ONLY to preserve reply structure
			// (ADR 0096 §5): keep it when it still has a live child (rendered as the
			// `[silindi]` tombstone by `rowToCommentRow`), otherwise omit it. A live
			// comment is always shown.
			const visible = sql`(${schema.commentRecord.removedAt} IS NULL OR EXISTS (SELECT 1 FROM ${schema.commentRecord} AS child WHERE child.parent_id = ${schema.commentRecord.id} AND child.removed_at IS NULL))`;
			const baseWhere = and(eq(schema.commentRecord.postId, postId), visible);
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.commentRecord)
					.where(baseWhere)
					.get()
					.then((r) => r?.n ?? 0),
			);

			// Resolve the (created_at) cursor tuple. The DB read is the port;
			// `resolveCursor` is the pure cursor-miss decision (see `listPostsConnection`).
			// The anchor lookup carries `visible`, so an invisible row (a removed leaf with
			// no live child) is no anchor at all — resolving to null → miss → empty page,
			// exactly as the old hard-delete made the cursor row vanish (ADR 0096 §5).
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.commentRecord.createdAt})
							.from(schema.commentRecord)
							.where(and(eq(schema.commentRecord.id, after), visible))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies CommentConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			const cursorPredicate = keysetAfter([
				{column: schema.commentRecord.createdAt, dir: "asc", value: cursorRow?.createdAt ?? null},
				{column: schema.commentRecord.id, dir: "asc", value: after},
			]);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentRecord)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(asc(schema.commentRecord.createdAt), asc(schema.commentRecord.id))
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
					return {...base, myVote: viewerId ? voted.has(c.id) : null};
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
						and(inArray(schema.postSummary.id, [...ids]), isNull(schema.postSummary.removedAt)),
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
					myVote: viewerId ? voted.has(row.id) : null,
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
					.from(schema.commentRecord)
					.where(inArray(schema.commentRecord.id, [...ids])),
			);
			const voted = yield* voteSvc.readMine(
				viewerId,
				"comment",
				fetched.map((c) => c.id),
			);
			return fetched.map((c): CommentRow => {
				const base = rowToCommentRow(c);
				return {...base, myVote: viewerId ? voted.has(c.id) : null};
			});
		});

		const lookupCommentPostId = Effect.fn("Pano.lookupCommentPostId")(function* (
			commentId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({postId: schema.commentRecord.postId})
					.from(schema.commentRecord)
					.where(eq(schema.commentRecord.id, commentId))
					.limit(1),
			);
			return rows[0]?.postId ?? null;
		});

		const submitPost = Effect.fn("Pano.submitPost")(function* (input: SubmitPostInput) {
			const title = yield* validatePostTitle(input.title ?? "");
			const body = yield* validatePostBody(input.body ?? "");
			const {host, urlNormalized} = yield* parseSubmitUrl(input.url);
			const normalizedTags = yield* normalizeSubmitTags(input.tags);

			const postId = id("post");
			const now = new Date();
			const hotScore = computeHotScore(0, now.getTime(), now.getTime());
			const bodyExcerpt = body ? excerpt(body) : null;
			const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

			// Summary insert + its FTS dual-write in ONE batch — all-or-none, so a
			// crash mid-write can't orphan a `post_search` row against a missing
			// `post_summary` row (the ADR 0080 lockstep invariant).
			yield* batch((db) => [
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
					removedAt: null,
					lastEventId: "",
				}),
				...syncPostSearch(db, postId, title),
			]);

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
			const rawTitle = yield* validateDraftTitle(input.title ?? "");
			const body = yield* validatePostBody(input.body ?? "");
			const {host, urlNormalized} = yield* parseSubmitUrl(input.url);
			const normalizedTags = yield* normalizeDraftTags(input.tags);

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
						removedAt: null,
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
					.where(
						and(
							eq(schema.postSummary.authorId, input.authorId),
							eq(schema.postSummary.isDraft, true),
						),
					),
			);
			return {postId: existing.id} satisfies DiscardDraftResult;
		});

		const editPost = Effect.fn("Pano.editPost")(function* (input: EditPostInput) {
			const meta = yield* run((db) =>
				db.query.postSummary.findFirst({
					where: {id: input.postId, removedAt: {isNull: true}},
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

			// Summary update + its FTS re-sync in ONE batch so they move all-or-none
			// (ADR 0080). The body is out of v1 search scope, so a body-only edit
			// leaves the FTS row untouched — only the summary update batches alone.
			yield* batch((db) => [
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
				...(hasTitle ? syncPostSearch(db, input.postId, nextTitle) : []),
			]);

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

		// SOFT delete onto the ADR 0096 substrate: stamp the `Removed` triad, wipe
		// votes via `Vote.clearTarget` (karma KEPT — the pano karma-reversal is
		// deleted), drop the FTS row, recompute stats outside. Restore is the inverse.
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
			if (Lifecycle.isRemoved(Lifecycle.fromColumns(meta))) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}

			const now = new Date();
			const removed = Lifecycle.toColumns(
				Lifecycle.remove({
					removedAt: now,
					removedBy: input.actorId,
					reason: input.reason ?? new Lifecycle.AuthorDeletion(),
				}),
			);
			yield* voteSvc.clearTarget("post", input.postId);
			// Soft-delete stamp + FTS removal in ONE batch so they move all-or-none
			// (ADR 0080 lockstep): a crash between them can't leave a `Removed` post
			// still searchable, or strand a `post_search` row past a restore. The FTS
			// removal builds from the id alone (no re-read of the removed row), so it
			// is batch-safe. Karma is KEPT (ADR 0096) — no karma-reversal here.
			yield* batch((db) => [
				db
					.update(schema.postSummary)
					.set({...removed, score: 0, hotScore: 0, updatedAt: now, lastActivityAt: now})
					.where(eq(schema.postSummary.id, input.postId)),
				removePostSearch(db, input.postId),
			]);

			yield* recomputePanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		const restorePost = Effect.fn("Pano.restorePost")(function* (input: DeletePostInput) {
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
			const lifecycle = Lifecycle.fromColumns(meta);
			if (!Lifecycle.isRemoved(lifecycle)) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}

			const now = new Date();
			const live = Lifecycle.toColumns(Lifecycle.restore(lifecycle));
			// Restore stamp + FTS re-entry in ONE batch (ADR 0080 lockstep). Votes
			// wiped on removal are not resurrected (score stays 0).
			yield* batch((db) => [
				db
					.update(schema.postSummary)
					.set({...live, updatedAt: now, lastActivityAt: now})
					.where(eq(schema.postSummary.id, input.postId)),
				...syncPostSearch(db, input.postId, meta.title),
			]);

			yield* recomputePanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		const moderateRemovePost = Effect.fn("Pano.moderateRemovePost")(function* (input: {
			postId: string;
			resolverId: string;
			reportId: string;
		}) {
			const meta = yield* run((db) => db.query.postSummary.findFirst({where: {id: input.postId}}));
			if (!meta || Lifecycle.isRemoved(Lifecycle.fromColumns(meta))) {
				return {removed: false};
			}

			const now = new Date();
			const removed = Lifecycle.toColumns(
				Lifecycle.remove({
					removedAt: now,
					removedBy: input.resolverId,
					reason: new Lifecycle.Moderated({reportId: input.reportId}),
				}),
			);
			yield* voteSvc.clearTarget("post", input.postId);
			// Moderation removal stamp + FTS removal in ONE batch (ADR 0080 lockstep),
			// mirroring `deletePost`. `removePostSearch` must be a drizzle query-builder
			// item, never `db.run(sql)` — only a builder `_prepare()`s to a bound D1
			// `.stmt` the batch driver binds; a raw `db.run(Stmt)` 500s in-batch and
			// fails typecheck (#920 — this path was a trailing un-batched `db.run`).
			yield* batch((db) => [
				db
					.update(schema.postSummary)
					.set({...removed, score: 0, hotScore: 0, updatedAt: now, lastActivityAt: now})
					.where(eq(schema.postSummary.id, input.postId)),
				removePostSearch(db, input.postId),
			]);
			yield* recomputePanoStats(now);

			return {removed: true};
		});

		const moderateRestorePost = Effect.fn("Pano.moderateRestorePost")(function* (input: {
			postId: string;
		}) {
			const meta = yield* run((db) => db.query.postSummary.findFirst({where: {id: input.postId}}));
			if (!meta) return {restored: false};
			const lifecycle = Lifecycle.fromColumns(meta);
			if (!Lifecycle.isRemoved(lifecycle)) return {restored: false};

			const now = new Date();
			const live = Lifecycle.toColumns(Lifecycle.restore(lifecycle));
			// Restore stamp + FTS re-entry in ONE batch (ADR 0080 lockstep), mirroring
			// `restorePost` — `syncPostSearch` returns drizzle query-builder items, not
			// `db.run(sql)`, so they `_prepare()` to bound D1 `.stmt`s the batch driver
			// binds (raw `db.run(Stmt)` 500s in-batch + fails typecheck; #920).
			yield* batch((db) => [
				db
					.update(schema.postSummary)
					.set({...live, updatedAt: now, lastActivityAt: now})
					.where(eq(schema.postSummary.id, input.postId)),
				...syncPostSearch(db, input.postId, meta.title),
			]);
			yield* recomputePanoStats(now);

			return {restored: true};
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
					where: {id: input.postId, removedAt: {isNull: true}},
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
					value: isVote,
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
					where: {id: input.postId, removedAt: {isNull: true}},
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
					db.query.commentRecord.findFirst({
						where: {id: parentId, postId: input.postId, removedAt: {isNull: true}},
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
				db.insert(schema.commentRecord).values({
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
					removedAt: null,
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
				db.query.commentRecord.findFirst({
					where: {id: input.commentId, removedAt: {isNull: true}},
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
					.update(schema.commentRecord)
					.set({body: rawBody, bodyExcerpt, updatedAt: now})
					.where(eq(schema.commentRecord.id, input.commentId)),
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
				db.query.commentRecord.findFirst({where: {id: input.commentId}}),
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
			if (Lifecycle.isRemoved(Lifecycle.fromColumns(row))) {
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
					.from(schema.commentRecord)
					.where(
						and(
							eq(schema.commentRecord.parentId, input.commentId),
							isNull(schema.commentRecord.removedAt),
						),
					)
					.get(),
			);
			const hasReplies = (childCountRow?.n ?? 0) > 0;

			const now = new Date();
			// SOFT remove for every comment now (ADR 0096 §1 — no hard delete): wipe
			// votes via `Vote.clearTarget` (karma KEPT), then stamp the `Removed`
			// triad. The canonical body is KEPT (the `[silindi]` tombstone is rendered
			// by `rowToCommentRow`, not written here), so restore + moderator review
			// have the real text. `hasReplies` now only shapes the result placeholder,
			// not the strategy. `commentCount` + stats refresh outside (caches).
			const removed = Lifecycle.toColumns(
				Lifecycle.remove({
					removedAt: now,
					removedBy: input.actorId,
					reason: input.reason ?? new Lifecycle.AuthorDeletion(),
				}),
			);
			yield* voteSvc.clearTarget("comment", input.commentId);
			yield* run((db) =>
				db
					.update(schema.commentRecord)
					.set({...removed, score: 0, updatedAt: now})
					.where(eq(schema.commentRecord.id, input.commentId)),
			);

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

		const restoreComment = Effect.fn("Pano.restoreComment")(function* (input: DeleteCommentInput) {
			const row = yield* run((db) =>
				db.query.commentRecord.findFirst({where: {id: input.commentId}}),
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
			const lifecycle = Lifecycle.fromColumns(row);
			if (!Lifecycle.isRemoved(lifecycle)) {
				return {
					commentId: input.commentId,
					deleted: false,
					hasReplies: false,
					placeholder: null,
				} satisfies DeleteCommentResult;
			}

			const now = new Date();
			const live = Lifecycle.toColumns(Lifecycle.restore(lifecycle));
			yield* run((db) =>
				db
					.update(schema.commentRecord)
					.set({...live, updatedAt: now})
					.where(eq(schema.commentRecord.id, input.commentId)),
			);

			const post = yield* run((db) => db.query.postSummary.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postSummary)
						.set({
							commentCount: post.commentCount + 1,
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postSummary.id, row.postId)),
				);
			}

			yield* recomputePanoStats(now);

			return {
				commentId: input.commentId,
				deleted: true,
				hasReplies: false,
				placeholder: null,
			} satisfies DeleteCommentResult;
		});

		const moderateRemoveComment = Effect.fn("Pano.moderateRemoveComment")(function* (input: {
			commentId: string;
			resolverId: string;
			reportId: string;
		}) {
			const row = yield* run((db) =>
				db.query.commentRecord.findFirst({where: {id: input.commentId}}),
			);
			if (!row || Lifecycle.isRemoved(Lifecycle.fromColumns(row))) {
				return {removed: false};
			}

			const now = new Date();
			const removed = Lifecycle.toColumns(
				Lifecycle.remove({
					removedAt: now,
					removedBy: input.resolverId,
					reason: new Lifecycle.Moderated({reportId: input.reportId}),
				}),
			);
			yield* voteSvc.clearTarget("comment", input.commentId);
			yield* run((db) =>
				db
					.update(schema.commentRecord)
					.set({...removed, score: 0, updatedAt: now})
					.where(eq(schema.commentRecord.id, input.commentId)),
			);

			const post = yield* run((db) => db.query.postSummary.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postSummary)
						.set({
							commentCount: Math.max(0, post.commentCount - 1),
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postSummary.id, row.postId)),
				);
			}
			yield* recomputePanoStats(now);

			return {removed: true};
		});

		const moderateRestoreComment = Effect.fn("Pano.moderateRestoreComment")(function* (input: {
			commentId: string;
		}) {
			const row = yield* run((db) =>
				db.query.commentRecord.findFirst({where: {id: input.commentId}}),
			);
			if (!row) return {restored: false};
			const lifecycle = Lifecycle.fromColumns(row);
			if (!Lifecycle.isRemoved(lifecycle)) return {restored: false};

			const now = new Date();
			const live = Lifecycle.toColumns(Lifecycle.restore(lifecycle));
			yield* run((db) =>
				db
					.update(schema.commentRecord)
					.set({...live, updatedAt: now})
					.where(eq(schema.commentRecord.id, input.commentId)),
			);

			const post = yield* run((db) => db.query.postSummary.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postSummary)
						.set({commentCount: post.commentCount + 1, updatedAt: now, lastActivityAt: now})
						.where(eq(schema.postSummary.id, row.postId)),
				);
			}
			yield* recomputePanoStats(now);

			return {restored: true};
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
				db.query.commentRecord.findFirst({
					where: {id: input.commentId, removedAt: {isNull: true}},
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
					value: isVote,
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
			restorePost,
			moderateRemovePost,
			moderateRestorePost,
			voteOnPost,
			retractPostVote,
			addComment,
			editComment,
			deleteComment,
			restoreComment,
			moderateRemoveComment,
			moderateRestoreComment,
			voteOnComment,
			retractCommentVote,
		};
	}),
);
