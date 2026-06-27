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
import {and, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {POST_SORT_LEAD_COLUMN, type PostSort} from "../../../src/lib/panoFeedSort.ts";
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
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import {isVisibleTo, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {syncPostSearch} from "../search/fts-sync.ts";
import {excerpt as excerptText} from "../text/index.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {type CommentConnectionPage, type CommentRow, toCommentRow} from "./comment-fields.ts";
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
import {COMMENT_ORDERING} from "./ordering.ts";
import {
	type PostConnectionPage,
	type PostPage,
	type PostSummaryRow,
	type PostTagRow,
	parseTags,
	toPostPage,
	toPostSummaryKeysetRow,
	toPostSummaryRow,
} from "./post-fields.ts";

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

// `PostTagRow` + `parseTags` live in `post-fields.ts` (the `Post` column→field
// map owns the `tags` CSV parse); re-exported so the long-lived server-side names
// keep resolving.
export type {PostTagRow};

/** Raw tag shape on submit/draft input — `label` is optional until normalized. */
export interface PostTagInput {
	kind: string;
	label?: string | undefined;
}

// Submit-validation lives here as module-private pure functions (ADR 0013 for
// *where* validation belongs, ADR 0082 for *why* it's lifted off the service):
// each is wrong-or-right on its input with no DB. The wire codes unit-test off-DB
// THROUGH the mutation (`submit-validation.unit.test.ts` drives `submitPost` /
// `saveDraft` / `addComment` / `editPost` over a throwing `Drizzle`, proving the
// gate fires before any DB call), and the integration tier keeps only the
// real-DB-miss cases. `submitPost` / `saveDraft` / `addComment` / `editPost` /
// `editComment` call these at the same point they used to call the in-factory
// closures, so observable behavior + wire codes are unchanged.

/** Returns the normalized body (`null` for empty), or fails `PostBodyTooLong`. */
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

/**
 * Draft title gate — `saveDraft` has no required title (a half-filled form
 * persists), only the length cap. Returns the trimmed title or fails
 * `TitleTooLong`.
 */
const validateDraftTitle = Effect.fn("Pano.validateDraftTitle")(function* (raw: string) {
	const trimmed = raw.trim();
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

/**
 * Parse an optional submit/draft URL to its normalized form + host. An empty or
 * absent URL yields `{host: null, urlNormalized: null}`; a malformed one fails
 * `UrlInvalid`. Shared by `submitPost` and `saveDraft`.
 */
const parseSubmitUrl = Effect.fn("Pano.parseSubmitUrl")(function* (url: string | null | undefined) {
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
const normalizeSubmitTags = Effect.fn("Pano.normalizeSubmitTags")(function* (
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
const normalizeDraftTags = Effect.fn("Pano.normalizeDraftTags")(function* (
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

export type {CommentConnectionPage, CommentRow} from "./comment-fields.ts";

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

// `Post` / `Comment` row + connection-page types derive from their column→field
// maps (`post-fields.ts` / `comment-fields.ts`, #1166); re-exported so the
// long-lived `Pano.ts` import surface keeps resolving.
export type {
	PostConnectionPage,
	PostPage,
	PostSummaryRow,
} from "./post-fields.ts";
export type {PostSort};

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: string;
	authorName: string;
	/**
	 * The çaylak mod-only sandbox stamp (#1205), decided by the resolver from the
	 * authorship flag + author tier. `null`/absent ⇒ posted live (today's behavior).
	 */
	sandboxedAt?: Date | null | undefined;
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
	reason?: Removal.RemovalReason;
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
	/**
	 * The çaylak mod-only sandbox stamp (#1205), decided by the resolver from the
	 * authorship flag + author tier. `null`/absent ⇒ created live (today's behavior).
	 */
	sandboxedAt?: Date | null | undefined;
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
	reason?: Removal.RemovalReason;
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
		readonly getPost: (
			postId: string,
			opts?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<PostPage | null>;

		readonly listPostsConnection: (opts?: {
			sort?: PostSort;
			first?: number;
			after?: string | null;
			host?: string | null;
			sandboxViewer?: SandboxViewer | undefined;
		}) => Effect.Effect<PostConnectionPage>;

		/**
		 * Keyset page over a post's comments, `(created_at asc, id asc)` (ADR 0019).
		 * `viewerId` stamps `myVote` for the whole page in one `user_vote` read;
		 * `sandboxViewer` filters the çaylak sandbox (#1205) per the same viewer.
		 */
		readonly listCommentsKeyset: (
			postId: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
			},
		) => Effect.Effect<CommentConnectionPage>;

		/** Post source `byIds` — batched read avoiding the relation N+1. */
		readonly getPostsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ReadonlyArray<PostSummaryRow>>;

		/** Comment source `byIds` — batched read avoiding the relation N+1. */
		readonly getCommentsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ReadonlyArray<CommentRow>>;

		/**
		 * The moderator sandbox-queue / promotion-backlog read models (#1205, #1206
		 * seam): a çaylak's still-sandboxed, not-removed posts/comments — scoped to one
		 * author when promotion flips their backlog.
		 */
		readonly listSandboxedPosts: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<ReadonlyArray<PostSummaryRow>>;
		readonly listSandboxedComments: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<ReadonlyArray<CommentRow>>;

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

		// The removal-sequence owner (#1129): the vote-wipe→stamp→FTS ordering is the
		// module's to enforce, not this service's to hand-wire.
		const removalSeq: Removal.RemovalSequence = {run, batch, clearTarget: voteSvc.clearTarget};

		// The viewer scalars per entity (#1126): `Post` carries `myVote` (batched
		// `user_vote`) + `isSaved` (batched `post_bookmark`); `Comment` carries
		// `myVote`. Every read finalizes through `stampViewerScalars` with these specs
		// — one `IN (...)` read per scalar for the whole batch, never a per-row N+1 —
		// so a new read path can't silently ship an always-`null` scalar.
		const postViewerScalars = [
			{
				field: "myVote",
				read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
					voteSvc.readMine(viewerId, "post", ids),
			},
			{
				field: "isSaved",
				read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
					bookmarkSvc.readMine(viewerId, ids),
			},
		] as const;
		const commentVoteScalar = {
			field: "myVote",
			read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
				voteSvc.readMine(viewerId, "comment", ids),
		} as const;

		const rowToPostPage = toPostPage;

		// The tombstone is rendered HERE, from the lifecycle projection — not written
		// into the canonical body by the delete path (ADR 0096 §5). A `Removed`
		// comment surfaces as the `[silindi]` placeholder with author elided; its real
		// body stays in the row for restore + moderator review. `deletedAt` on the
		// wire-facing `CommentRow` is the removal timestamp (presentation contract).
		// The live shape comes from the `comment-fields.ts` column→field map; the
		// tombstone overrides the four presentation fields it elides.
		const rowToCommentRow = (row: typeof schema.commentRecord.$inferSelect): CommentRow => {
			const lifecycle = Removal.fromColumns(row);
			if (Removal.isRemoved(lifecycle)) {
				return {
					...toCommentRow(row),
					author: "",
					authorId: "",
					body: SILINDI_PLACEHOLDER,
					deletedAt: lifecycle.removedAt,
				};
			}
			return toCommentRow(row);
		};

		// Refresh `pano_stats`. The closure is just the port: gather the three live
		// COUNTs via `run`, call the pure `recomputePanoStats` fold (module scope),
		// persist via the upsert. Runs after every write that could affect totals.
		const persistPanoStats = Effect.fn("Pano.recomputePanoStats")(function* (now: Date) {
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

		const getPost = Effect.fn("Pano.getPost")(function* (
			postId: string,
			opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
		) {
			const meta = yield* run((db) =>
				db.query.postRecord.findFirst({
					where: {id: postId, removedAt: {isNull: true}},
				}),
			);
			if (!meta) return null;
			// A sandboxed post (#1205) is hidden from anyone but its author + a
			// moderator — the in-memory mirror of the list reads' SQL predicate, since
			// this single-row read uses the relational query builder.
			if (!isVisibleTo(Removal.fromColumns(meta), meta.authorId, resolveSandboxViewer(opts))) {
				return null;
			}
			return rowToPostPage(meta);
		});

		const listPostsConnection = Effect.fn("Pano.listPostsConnection")(function* (
			opts: {
				sort?: PostSort;
				first?: number;
				after?: string | null;
				host?: string | null;
				sandboxViewer?: SandboxViewer | undefined;
			} = {},
		) {
			const sort = opts.sort ?? "hot";
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;
			const host = opts.host ?? null;

			// `is_draft IS NOT 1` excludes drafts from the public feed while keeping
			// null/0 rows (published) — drafts are private to their author (#746).
			const baseConditions = [
				isNull(schema.postRecord.removedAt),
				sql`${schema.postRecord.isDraft} is not 1`,
			];
			if (host) baseConditions.push(eq(schema.postRecord.host, host));
			// Filter the çaylak sandbox (#1205) for this viewer at the same layer.
			const sandboxClause = sandboxVisibleWhere(
				{sandboxedAt: schema.postRecord.sandboxedAt, authorId: schema.postRecord.authorId},
				resolveSandboxViewer(opts),
			);
			if (sandboxClause) baseConditions.push(sandboxClause);

			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.postRecord)
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
								id: schema.postRecord.id,
								score: schema.postRecord.score,
								hotScore: schema.postRecord.hotScore,
								commentCount: schema.postRecord.commentCount,
								createdAt: schema.postRecord.createdAt,
							})
							.from(schema.postRecord)
							.where(eq(schema.postRecord.id, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor<CursorRow>(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies PostConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// Both the keyset cursor predicate and `orderBy` derive from the one
			// `POST_SORT_LEAD_COLUMN` map: an optional lead column (descending) +
			// `id` desc tiebreaker; `new` (no lead column) orders by `id` alone.
			const leadKey = POST_SORT_LEAD_COLUMN[sort];
			const leadColumn = leadKey
				? {column: schema.postRecord[leadKey], value: cursorRow?.[leadKey]}
				: null;

			const cursorPredicate = keysetAfter([
				...(leadColumn
					? [{column: leadColumn.column, dir: "desc" as const, value: leadColumn.value ?? null}]
					: []),
				{column: schema.postRecord.id, dir: "desc", value: cursorRow?.id ?? null},
			]);

			const whereExpr = cursorPredicate
				? and(...baseConditions, cursorPredicate)
				: and(...baseConditions);

			const orderBy = [
				...(leadColumn ? [desc(leadColumn.column)] : []),
				desc(schema.postRecord.id),
			];

			const fetched = yield* run((db) =>
				db
					.select({
						id: schema.postRecord.id,
						slug: schema.postRecord.slug,
						title: schema.postRecord.title,
						url: schema.postRecord.url,
						host: schema.postRecord.host,
						bodyExcerpt: schema.postRecord.bodyExcerpt,
						authorId: schema.postRecord.authorId,
						authorName: schema.postRecord.authorName,
						score: schema.postRecord.score,
						commentCount: schema.postRecord.commentCount,
						createdAt: schema.postRecord.createdAt,
						tags: schema.postRecord.tags,
					})
					.from(schema.postRecord)
					.where(whereExpr)
					.orderBy(...orderBy)
					.limit(first + 1),
			);

			// Route the keyset projection through the same `post-fields.ts` column→field
			// map the by-id path uses, so `body` collapses to `null` for an empty excerpt
			// (not `""`) — the divergence is unrepresentable, not hand-synced (#1170).
			const page = forwardPage(fetched, first, (r) => r.id, toPostSummaryKeysetRow);

			return {...page, totalCount} satisfies PostConnectionPage;
		});

		const listCommentsKeyset = Effect.fn("Pano.listCommentsKeyset")(function* (
			postId: string,
			opts: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
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
			// A çaylak-sandboxed comment (#1205) is filtered for this viewer beside the
			// removal/reply-structure guard above.
			const sandboxClause = sandboxVisibleWhere(
				{sandboxedAt: schema.commentRecord.sandboxedAt, authorId: schema.commentRecord.authorId},
				resolveSandboxViewer(opts),
			);
			const baseWhere = and(eq(schema.commentRecord.postId, postId), visible, sandboxClause);
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

			// The predicate and `orderBy` derive from `COMMENT_ORDERING`; the `id`
			// cursor value is the opaque `after` (the resolved row carries only
			// `createdAt`).
			const cursorPredicate = keysetAfter(
				keysetKeys(COMMENT_ORDERING, (field) =>
					field === "id" ? after : (cursorRow?.createdAt ?? null),
				),
			);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentRecord)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(...orderByColumns(COMMENT_ORDERING))
					.limit(first + 1),
			);

			const page = forwardPage(fetched, first, (r: CommentRow) => r.id, rowToCommentRow);
			const rows = yield* stampViewerScalars(page.rows, viewerId, [commentVoteScalar]);

			return {...page, rows, totalCount} satisfies CommentConnectionPage;
		});

		const getPostsByIds = Effect.fn("Pano.getPostsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.postRecord)
					.where(
						and(
							inArray(schema.postRecord.id, [...ids]),
							isNull(schema.postRecord.removedAt),
							sandboxVisibleWhere(
								{
									sandboxedAt: schema.postRecord.sandboxedAt,
									authorId: schema.postRecord.authorId,
								},
								resolveSandboxViewer(opts),
							),
						),
					),
			);
			// `myVote`/`isSaved` are the viewer scalars, finalized via `stampViewerScalars`
			// (one `user_vote` + one `post_bookmark` read for the whole batch); the row's
			// intrinsic fields come from the `post-fields.ts` column→field map — incl.
			// `isDraft`, read off the row itself (a by-id read returns the author's own
			// draft, read-your-writes), not a viewer-presence read.
			const intrinsic = fetched.map(toPostSummaryRow);
			return yield* stampViewerScalars(intrinsic, viewerId, postViewerScalars);
		});

		const getCommentsByIds = Effect.fn("Pano.getCommentsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentRecord)
					.where(
						and(
							inArray(schema.commentRecord.id, [...ids]),
							sandboxVisibleWhere(
								{
									sandboxedAt: schema.commentRecord.sandboxedAt,
									authorId: schema.commentRecord.authorId,
								},
								resolveSandboxViewer(opts),
							),
						),
					),
			);
			return yield* stampViewerScalars(fetched.map(rowToCommentRow), viewerId, [commentVoteScalar]);
		});

		// The moderator sandbox-queue / promotion-backlog read models (#1205, the
		// #1206 seam): a çaylak's still-sandboxed, not-removed posts/comments — scoped
		// to one author when promotion flips their backlog. Authority is gated at the
		// resolver; the service reads are unconditional.
		const listSandboxedPosts = Effect.fn("Pano.listSandboxedPosts")(function* (
			opts: {authorId?: string | undefined} = {},
		) {
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.postRecord)
					.where(
						sandboxBacklogWhere(
							{
								sandboxedAt: schema.postRecord.sandboxedAt,
								removedAt: schema.postRecord.removedAt,
								authorId: schema.postRecord.authorId,
							},
							{authorId: opts.authorId},
						),
					)
					.orderBy(desc(schema.postRecord.createdAt)),
			);
			return fetched.map(toPostSummaryRow);
		});

		const listSandboxedComments = Effect.fn("Pano.listSandboxedComments")(function* (
			opts: {authorId?: string | undefined} = {},
		) {
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.commentRecord)
					.where(
						sandboxBacklogWhere(
							{
								sandboxedAt: schema.commentRecord.sandboxedAt,
								removedAt: schema.commentRecord.removedAt,
								authorId: schema.commentRecord.authorId,
							},
							{authorId: opts.authorId},
						),
					)
					.orderBy(desc(schema.commentRecord.createdAt)),
			);
			return fetched.map(rowToCommentRow);
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
			// `post_record` row (the ADR 0080 lockstep invariant).
			yield* batch((db) => [
				db.insert(schema.postRecord).values({
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
					sandboxedAt: input.sandboxedAt ?? null,
					lastEventId: "",
				}),
				...syncPostSearch(db, postId, title),
			]);

			yield* persistPanoStats(now);

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
				db.query.postRecord.findFirst({
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
						.update(schema.postRecord)
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
						.where(eq(schema.postRecord.id, postId)),
				);
			} else {
				yield* run((db) =>
					db.insert(schema.postRecord).values({
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
				db.query.postRecord.findFirst({
					where: {authorId: input.authorId, isDraft: true},
					columns: {id: true},
				}),
			);
			if (!existing) return {postId: null} satisfies DiscardDraftResult;
			yield* run((db) =>
				db
					.delete(schema.postRecord)
					.where(
						and(
							eq(schema.postRecord.authorId, input.authorId),
							eq(schema.postRecord.isDraft, true),
						),
					),
			);
			return {postId: existing.id} satisfies DiscardDraftResult;
		});

		const editPost = Effect.fn("Pano.editPost")(function* (input: EditPostInput) {
			const meta = yield* run((db) =>
				db.query.postRecord.findFirst({
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
					.update(schema.postRecord)
					.set({
						title: nextTitle,
						body: nextBodyStored,
						bodyExcerpt: nextBodyExcerpt,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, input.postId)),
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
			const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
			if (!meta) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}
			if (meta.authorId !== input.actorId) {
				return yield* new UnauthorizedPostMutation({
					postId: input.postId,
					message: `not authorized to mutate post ${input.postId}`,
				});
			}
			if (Removal.isRemoved(Removal.fromColumns(meta))) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}

			const now = new Date();
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: now,
					removedBy: input.actorId,
					reason: input.reason ?? new Removal.AuthorDeletion(),
				}),
			);
			yield* Removal.removeEntity(removalSeq, {kind: "post", id: input.postId}, removed, now);

			yield* persistPanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		const restorePost = Effect.fn("Pano.restorePost")(function* (input: DeletePostInput) {
			const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
			if (!meta) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}
			if (meta.authorId !== input.actorId) {
				return yield* new UnauthorizedPostMutation({
					postId: input.postId,
					message: `not authorized to mutate post ${input.postId}`,
				});
			}
			const lifecycle = Removal.fromColumns(meta);
			if (!Removal.isRemoved(lifecycle)) {
				return {postId: input.postId, deleted: false} satisfies DeletePostResult;
			}

			const now = new Date();
			const live = Removal.toColumns(Removal.restore(lifecycle));
			yield* Removal.restoreEntity(
				removalSeq,
				{kind: "post", id: input.postId, title: meta.title},
				live,
				now,
			);

			yield* persistPanoStats(now);

			return {postId: input.postId, deleted: true} satisfies DeletePostResult;
		});

		const moderateRemovePost = Effect.fn("Pano.moderateRemovePost")(function* (input: {
			postId: string;
			resolverId: string;
			reportId: string;
		}) {
			const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
			if (!meta || Removal.isRemoved(Removal.fromColumns(meta))) {
				return {removed: false};
			}

			const now = new Date();
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: now,
					removedBy: input.resolverId,
					reason: new Removal.Moderated({reportId: input.reportId}),
				}),
			);
			yield* Removal.removeEntity(removalSeq, {kind: "post", id: input.postId}, removed, now);
			yield* persistPanoStats(now);

			return {removed: true};
		});

		const moderateRestorePost = Effect.fn("Pano.moderateRestorePost")(function* (input: {
			postId: string;
		}) {
			const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
			if (!meta) return {restored: false};
			const lifecycle = Removal.fromColumns(meta);
			if (!Removal.isRemoved(lifecycle)) return {restored: false};

			const now = new Date();
			const live = Removal.toColumns(Removal.restore(lifecycle));
			yield* Removal.restoreEntity(
				removalSeq,
				{kind: "post", id: input.postId, title: meta.title},
				live,
				now,
			);
			yield* persistPanoStats(now);

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
				db.query.postRecord.findFirst({
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
				? yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}))
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
				db.query.postRecord.findFirst({
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
					sandboxedAt: input.sandboxedAt ?? null,
					lastEventId: "",
				}),
			);

			// A sandboxed çaylak comment (#1205) is pending — it must not bump the
			// post's PUBLIC `comment_count`. Promotion (#1206) recomputes it on flip.
			const newCommentCount = post.commentCount + (input.sandboxedAt != null ? 0 : 1);
			const hotScore = computeHotScore(
				post.score,
				(post.createdAt ?? now).getTime(),
				now.getTime(),
			);

			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						commentCount: newCommentCount,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, input.postId)),
			);

			yield* persistPanoStats(now);

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
			if (Removal.isRemoved(Removal.fromColumns(row))) {
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
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: now,
					removedBy: input.actorId,
					reason: input.reason ?? new Removal.AuthorDeletion(),
				}),
			);
			yield* Removal.removeEntity(removalSeq, {kind: "comment", id: input.commentId}, removed, now);

			const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
			if (post) {
				const newCommentCount = Math.max(0, post.commentCount - 1);
				const hotScore = computeHotScore(
					post.score,
					(post.createdAt ?? now).getTime(),
					now.getTime(),
				);
				yield* run((db) =>
					db
						.update(schema.postRecord)
						.set({
							commentCount: newCommentCount,
							hotScore,
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postRecord.id, row.postId)),
				);
			}

			yield* persistPanoStats(now);

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
			const lifecycle = Removal.fromColumns(row);
			if (!Removal.isRemoved(lifecycle)) {
				return {
					commentId: input.commentId,
					deleted: false,
					hasReplies: false,
					placeholder: null,
				} satisfies DeleteCommentResult;
			}

			const now = new Date();
			const live = Removal.toColumns(Removal.restore(lifecycle));
			yield* Removal.restoreEntity(removalSeq, {kind: "comment", id: input.commentId}, live, now);

			const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postRecord)
						.set({
							commentCount: post.commentCount + 1,
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postRecord.id, row.postId)),
				);
			}

			yield* persistPanoStats(now);

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
			if (!row || Removal.isRemoved(Removal.fromColumns(row))) {
				return {removed: false};
			}

			const now = new Date();
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: now,
					removedBy: input.resolverId,
					reason: new Removal.Moderated({reportId: input.reportId}),
				}),
			);
			yield* Removal.removeEntity(removalSeq, {kind: "comment", id: input.commentId}, removed, now);

			const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postRecord)
						.set({
							commentCount: Math.max(0, post.commentCount - 1),
							updatedAt: now,
							lastActivityAt: now,
						})
						.where(eq(schema.postRecord.id, row.postId)),
				);
			}
			yield* persistPanoStats(now);

			return {removed: true};
		});

		const moderateRestoreComment = Effect.fn("Pano.moderateRestoreComment")(function* (input: {
			commentId: string;
		}) {
			const row = yield* run((db) =>
				db.query.commentRecord.findFirst({where: {id: input.commentId}}),
			);
			if (!row) return {restored: false};
			const lifecycle = Removal.fromColumns(row);
			if (!Removal.isRemoved(lifecycle)) return {restored: false};

			const now = new Date();
			const live = Removal.toColumns(Removal.restore(lifecycle));
			yield* Removal.restoreEntity(removalSeq, {kind: "comment", id: input.commentId}, live, now);

			const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
			if (post) {
				yield* run((db) =>
					db
						.update(schema.postRecord)
						.set({commentCount: post.commentCount + 1, updatedAt: now, lastActivityAt: now})
						.where(eq(schema.postRecord.id, row.postId)),
				);
			}
			yield* persistPanoStats(now);

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
			listSandboxedPosts,
			listSandboxedComments,
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
