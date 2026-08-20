/**
 * Pano — the link aggregator / discussion feature service. One service tag, two planes
 * implemented apart (`post-operations.ts` / `comment-operations.ts`) and spread back
 * into one object here, so the wire surface is unchanged by the split. Vote mutations
 * delegate to `Vote.cast` and translate `VoteTargetNotFound` into
 * `PostNotFound` / `CommentNotFound` so the resolver codec keeps its wire codes.
 * Validation lives in the service methods, not resolvers (ADR 0013).
 */
import {Context, Effect, Layer} from "effect";
import type {PostSort} from "../../../src/lib/panoFeedSort.ts";
import {POST_TAG_KINDS, type PostTagKind, tagLabel} from "../../../src/lib/panoTags.ts";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import type * as Removal from "../lifecycle/removal.ts";
import type {MaskedReadOptions} from "../lifecycle/SandboxVisibility.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Reaction} from "../reaction/Reaction.ts";
import type {ReportId} from "../report/ids.ts";
import type {SelfVoteNotAllowed, VoterNotEligible} from "../vote/errors.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import type {CommentConnectionPage, CommentRow} from "./comment-fields.ts";
import {
	type AddCommentInput,
	type AddCommentResult,
	COMMENT_BODY_MAX,
	type DeleteCommentInput,
	type DeleteCommentResult,
	type EditCommentInput,
	type EditCommentResult,
	makeCommentOperations,
	type ReactToCommentInput,
	type ReactToCommentResult,
	SILINDI_PLACEHOLDER,
	type VoteOnCommentInput,
	type VoteOnCommentResult,
} from "./comment-operations.ts";
import type {
	CommentNotFound,
	CommentValidation,
	PostNotFound,
	PostValidation,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "./errors.ts";
import {
	makePersistPanoStats,
	type PanoStats,
	type PanoStatsCounts,
	recomputePanoStats,
} from "./pano-stats.ts";
import type {PostConnectionPage, PostPage, PostSummaryRow, PostTagRow} from "./post-fields.ts";
import {
	type DeletePostInput,
	type DeletePostResult,
	type DiscardDraftInput,
	type DiscardDraftResult,
	type EditPostInput,
	type EditPostResult,
	makePostOperations,
	POST_BODY_MAX,
	POST_TITLE_MAX,
	type PostTagInput,
	type ReactToPostInput,
	type ReactToPostResult,
	type RestorePostResult,
	type SaveDraftInput,
	type SaveDraftResult,
	type SubmitPostInput,
	type SubmitPostResult,
	type VoteOnPostInput,
	type VoteOnPostResult,
} from "./post-operations.ts";

// The tags' single typed home is `src/lib/panoTags.ts`; re-exported so the long-lived
// server-side names keep resolving.
export {tagLabel};
export const ALLOWED_POST_TAG_KINDS = POST_TAG_KINDS;
export type AllowedPostTagKind = PostTagKind;

export type {
	AddCommentInput,
	AddCommentResult,
	CommentConnectionPage,
	CommentRow,
	DeleteCommentInput,
	DeleteCommentResult,
	DeletePostInput,
	DeletePostResult,
	DiscardDraftInput,
	DiscardDraftResult,
	EditCommentInput,
	EditCommentResult,
	EditPostInput,
	EditPostResult,
	PanoStats,
	PanoStatsCounts,
	PostConnectionPage,
	PostPage,
	PostSort,
	PostSummaryRow,
	PostTagInput,
	PostTagRow,
	ReactToCommentInput,
	ReactToCommentResult,
	ReactToPostInput,
	ReactToPostResult,
	RestorePostResult,
	SaveDraftInput,
	SaveDraftResult,
	SubmitPostInput,
	SubmitPostResult,
	VoteOnCommentInput,
	VoteOnCommentResult,
	VoteOnPostInput,
	VoteOnPostResult,
};
export {COMMENT_BODY_MAX, POST_BODY_MAX, POST_TITLE_MAX, recomputePanoStats, SILINDI_PLACEHOLDER};

export class Pano extends Context.Service<
	Pano,
	{
		readonly getPost: (
			postId: string,
			opts: MaskedReadOptions & {
				viewerId?: string | null | undefined;
				/** Mute read-mask (#3113): a muted author's post reads as not-found. */
				mutedIds?: ReadonlySet<string> | undefined;
			},
		) => Effect.Effect<PostPage | null>;

		readonly listPostsConnection: (
			opts: MaskedReadOptions & {
				sort?: PostSort;
				first?: number;
				after?: string | null;
				host?: string | null;
				mutedIds?: ReadonlySet<string> | undefined;
			},
		) => Effect.Effect<PostConnectionPage>;

		/** Keyset page over a post's comments, `(created_at asc, id asc)` (ADR 0019). */
		readonly listCommentsKeyset: (
			postId: string,
			opts: MaskedReadOptions & {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				mutedIds?: ReadonlySet<string> | undefined;
				/** Collapse the finalize stamps into one concurrent wave (#2710). Default off. */
				parallelStamps?: boolean | undefined;
			},
		) => Effect.Effect<CommentConnectionPage>;

		/** Post source `byIds` — batched read avoiding the relation N+1. */
		readonly getPostsByIds: (
			ids: ReadonlyArray<string>,
			opts: MaskedReadOptions & {
				viewerId?: string | null | undefined;
				mutedIds?: ReadonlySet<string> | undefined;
			},
		) => Effect.Effect<ReadonlyArray<PostSummaryRow>>;

		/**
		 * The per-viewer `myVote`/`isSaved` slice the cacheable base feed omits. Reads no
		 * `post_record` — one `IN (...)` per scalar, never per-row.
		 */
		readonly readViewerOverlay: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<
			ReadonlyArray<{id: string; myVote: boolean | null; isSaved: boolean | null}>
		>;

		/** Comment source `byIds` — batched read avoiding the relation N+1. */
		readonly getCommentsByIds: (
			ids: ReadonlyArray<string>,
			opts: MaskedReadOptions & {
				viewerId?: string | null | undefined;
				mutedIds?: ReadonlySet<string> | undefined;
				/** Collapse the finalize stamps into one concurrent wave (#2710). Default off. */
				parallelStamps?: boolean | undefined;
			},
		) => Effect.Effect<ReadonlyArray<CommentRow>>;

		/**
		 * A çaylak's still-sandboxed, not-removed content — scoped to one author when a
		 * promotion flips their backlog.
		 */
		readonly listSandboxedPosts: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<ReadonlyArray<PostSummaryRow>>;
		readonly listSandboxedComments: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<ReadonlyArray<CommentRow>>;

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

		/**
		 * Un-remove a `Removed` post (ADR 0096 §4); re-enters search, votes stay wiped.
		 * `sandboxedAt` is non-null iff the post returned to the çaylak sandbox, so the
		 * mutation can suppress the live echo.
		 */
		readonly restorePost: (
			input: DeletePostInput,
		) => Effect.Effect<RestorePostResult, UnauthorizedPostMutation>;

		/**
		 * Moderator soft-delete (ADR 0098 §6) — same substrate write as `deletePost` but
		 * gated on moderator authority, NOT author ownership. A missing target is a no-op.
		 */
		readonly moderateRemovePost: (input: {
			postId: string;
			resolverId: string;
			reportId: ReportId;
		}) => Effect.Effect<{removed: boolean}>;

		/**
		 * Moderator restore (ADR 0098 §3) — reopens the report at the resolve layer.
		 * `sandboxedAt` non-null means the restored post is still sandboxed, so report's
		 * live re-append keeps it out of the public feed.
		 */
		readonly moderateRestorePost: (input: {
			postId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// The two cast-only failures: the "earn to vote" gate (`Vote.castImpl`) and the
		// self-vote refusal. Retraction raises neither, so its channel stays narrower.
		readonly voteOnPost: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound | VoterNotEligible | SelfVoteNotAllowed>;

		readonly retractPostVote: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound>;

		/**
		 * The karma-free, ungated twin of `voteOnPost`: `null` emoji retracts, a çaylak may
		 * react, and no karma is written. The only failure is a missing/removed target.
		 */
		readonly reactToPost: (
			input: ReactToPostInput,
		) => Effect.Effect<ReactToPostResult, PostNotFound>;

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
			reportId: ReportId;
		}) => Effect.Effect<{removed: boolean}>;

		/** Moderator restore of a comment — the `moderateRestorePost` shape, for the thread. */
		readonly moderateRestoreComment: (input: {
			commentId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// Cast-only failures — see `voteOnPost`.
		readonly voteOnComment: (
			input: VoteOnCommentInput,
		) => Effect.Effect<
			VoteOnCommentResult,
			CommentNotFound | VoterNotEligible | SelfVoteNotAllowed
		>;

		readonly retractCommentVote: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound>;

		/** The comment mirror of `reactToPost`. */
		readonly reactToComment: (
			input: ReactToCommentInput,
		) => Effect.Effect<ReactToCommentResult, CommentNotFound>;

		/**
		 * Cron-driven sıcak/hot decay refresh: recompute the stored `hot_score` for every
		 * live, non-draft post at `now`, so an inactive post decays without an activity
		 * write. Deliberately a stored-column refresh and never a read-time recompute —
		 * that is what keeps the feed's keyset pagination valid.
		 */
		readonly refreshHotScores: (
			now: Date,
		) => Effect.Effect<{readonly scanned: number; readonly updated: number}>;
	}
>()("@kampus/pano/Pano") {}

export const PanoLive = Layer.effect(Pano)(
	Effect.gen(function* () {
		// `orDieAccess` dies on `DrizzleError`, so public signatures carry domain errors
		// only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const voteSvc = yield* Vote;
		const bookmarkSvc = yield* Bookmark;
		const reactionSvc = yield* Reaction;
		// Reads the CURRENT `{username, displayName}` per page, so the read surfaces render
		// live identity rather than the stale `authorName` snapshot on the row.
		const pasaport = yield* Pasaport;

		// The vote-wipe→stamp→FTS ordering is the removal module's to enforce, not this
		// service's to hand-wire.
		const removalSeq: Removal.RemovalSequence = {run, batch, clearTarget: voteSvc.clearTarget};

		const persistPanoStats = makePersistPanoStats(run);

		const postOps = makePostOperations({
			run,
			batch,
			voteSvc,
			bookmarkSvc,
			reactionSvc,
			removalSeq,
			persistPanoStats,
			readProfileIdentities: pasaport.getProfileIdentitiesByIds,
		});
		const commentOps = makeCommentOperations({
			run,
			voteSvc,
			reactionSvc,
			removalSeq,
			persistPanoStats,
			readProfileIdentities: pasaport.getProfileIdentitiesByIds,
		});

		return {...postOps, ...commentOps};
	}),
);
