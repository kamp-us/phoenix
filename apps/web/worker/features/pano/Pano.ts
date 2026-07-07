/**
 * Pano — the link aggregator / discussion feature service. Resolver-facing
 * surface for post + comment CRUD, vote delegation, and connection-shaped
 * pagination.
 *
 * The service is one `Pano` tag with a single public surface, but its two planes
 * live apart: the posts plane in `post-operations.ts`, the comments plane in
 * `comment-operations.ts`, and the cross-plane `pano_stats` cache in
 * `pano-stats.ts`. `PanoLive` is the thin wiring seam — it builds the shared deps
 * once and hands them to each plane's factory, then spreads the two closure sets
 * into the one service object, so the wire surface is identical to when both planes
 * shared this file.
 *
 * Vote mutations delegate to `Vote.cast` rather than reimplementing the batched
 * vote / karma / score-cache logic; the Pano-side wrappers re-load the target
 * row for the canonical resolver shape and translate `VoteTargetNotFound` into
 * `PostNotFound` / `CommentNotFound` so the resolver codec keeps producing
 * `POST_NOT_FOUND` / `COMMENT_NOT_FOUND`.
 *
 * Validation lives in the service methods, not resolvers (ADR 0013).
 */
import {Context, Effect, Layer} from "effect";
import type {PostSort} from "../../../src/lib/panoFeedSort.ts";
import {POST_TAG_KINDS, type PostTagKind, tagLabel} from "../../../src/lib/panoTags.ts";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import type * as Removal from "../lifecycle/removal.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Reaction} from "../reaction/Reaction.ts";
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

// The tag enum + label aliases have a single typed home in `src/lib/panoTags.ts`,
// cross-included by the worker tsconfig (#1030); re-exported here so the long-lived
// server-side names (consumed by `sources.ts` etc.) keep resolving.
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
// Constants, the stats fold, and the per-plane input/result types keep their
// long-lived `Pano.ts` import paths via these re-exports, so callers (resolvers,
// tests, the cross-feature consumers) are untouched by the post/comment split.
export {COMMENT_BODY_MAX, POST_BODY_MAX, POST_TITLE_MAX, recomputePanoStats, SILINDI_PLACEHOLDER};

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

		/**
		 * Un-remove a `Removed` post (ADR 0096 §4); re-enters search, votes stay wiped.
		 * Sandbox-faithful (#1811): the result's `sandboxedAt` is non-null iff the post
		 * returned to the çaylak sandbox, so the mutation can suppress the live echo.
		 */
		readonly restorePost: (
			input: DeletePostInput,
		) => Effect.Effect<RestorePostResult, UnauthorizedPostMutation>;

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

		/**
		 * Moderator restore (ADR 0098 §3) — reopens the report at the resolve layer.
		 * `sandboxedAt` is the target's round-tripped sandbox marker (#1811): non-null
		 * iff the restored post is still sandboxed, so report's live re-append gates the
		 * public-feed broadcast (a sandboxed restore stays suppressed, #1205/#1280).
		 */
		readonly moderateRestorePost: (input: {
			postId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// `VoterNotEligible` (#1810): a çaylak newcomer's cast is rejected — the "earn to vote"
		// gate lives in `Vote.castImpl`. `SelfVoteNotAllowed` (#2216): a cast on one's own post
		// is rejected at the cast site. Both surface on the cast path only — retraction raises
		// neither (nothing to retract), so `retractPostVote` keeps its `PostNotFound` channel.
		readonly voteOnPost: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound | VoterNotEligible | SelfVoteNotAllowed>;

		readonly retractPostVote: (
			input: VoteOnPostInput,
		) => Effect.Effect<VoteOnPostResult, PostNotFound>;

		/**
		 * React to a post — the karma-free, ungated twin of `voteOnPost` (#1863).
		 * Delegates to `Reaction.react` (kind `post`): a palette `emoji` sets/changes
		 * the viewer's single reaction, `null` retracts it. Re-resolves the post so the
		 * result carries the fresh `reactions` aggregate. NO tier gate (a çaylak may
		 * react) and NO karma write — the only failure is a missing/removed target.
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
			reportId: string;
		}) => Effect.Effect<{removed: boolean}>;

		/**
		 * Moderator restore of a comment (ADR 0098 §3) — reopens the report at the resolve
		 * layer. `sandboxedAt` is the round-tripped sandbox marker (#1811) so report's live
		 * re-append gates the thread broadcast (a sandboxed restore stays suppressed).
		 */
		readonly moderateRestoreComment: (input: {
			commentId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// `VoterNotEligible` (#1810) — see `voteOnPost`. Cast path only; retraction is exempt.
		readonly voteOnComment: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound | VoterNotEligible>;

		readonly retractCommentVote: (
			input: VoteOnCommentInput,
		) => Effect.Effect<VoteOnCommentResult, CommentNotFound>;

		/**
		 * React to a comment — the karma-free, ungated twin of `voteOnComment` (#1864),
		 * the direct mirror of `reactToPost`. Delegates to `Reaction.react` (kind
		 * `comment`): a palette `emoji` sets/changes the viewer's single reaction,
		 * `null` retracts it. Re-resolves the comment so the result carries the fresh
		 * `reactions` aggregate. NO tier gate (a çaylak may react) and NO karma write —
		 * the only failure is a missing/removed target.
		 */
		readonly reactToComment: (
			input: ReactToCommentInput,
		) => Effect.Effect<ReactToCommentResult, CommentNotFound>;

		/**
		 * Periodic sıcak/hot decay-refresh (#2027, windowless since #2133): recompute the
		 * stored `hot_score` for EVERY live, non-draft post at `now` and write back the
		 * changed rows, so an inactive post's ranking decays with age at any age without an
		 * activity write. Driven by the cron trigger (`index.ts`); the stored-column +
		 * keyset-cursor design is preserved (no read-time recompute). Returns the pass's
		 * scanned/updated counts for observability.
		 */
		readonly refreshHotScores: (
			now: Date,
		) => Effect.Effect<{readonly scanned: number; readonly updated: number}>;
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
		const reactionSvc = yield* Reaction;
		// Live author-identity resolver (#2139): one batched `user_profile` read per page
		// (`getProfileIdentitiesByIds`) stamps the CURRENT `{username, displayName}` so the
		// post/comment read surfaces render via `actorLabel`, not the `authorName` snapshot.
		const pasaport = yield* Pasaport;

		// The removal-sequence owner (#1129): the vote-wipe→stamp→FTS ordering is the
		// module's to enforce, not this service's to hand-wire.
		const removalSeq: Removal.RemovalSequence = {run, batch, clearTarget: voteSvc.clearTarget};

		// The cross-plane `pano_stats` port (post + comment + author totals), refreshed
		// after every write that could move them — passed to both planes so the fold has
		// one home (`pano-stats.ts`).
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
