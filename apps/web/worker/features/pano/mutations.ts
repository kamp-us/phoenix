/**
 * Pano mutation resolvers — the post + comment write path. Each returns the
 * re-resolved affected entity shaped like a read (ADR 0020); a delete returns a bare
 * `{id}` eviction ref. See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_REACTIONS} from "../../../src/flags/keys.ts";
import {ReactionEmojiSchema} from "../../db/reaction-emoji.ts";
import {UserId} from "../../lib/ids.ts";
import {notifyCommentReply} from "../bildirim/conversation-emitters.ts";
import {notifyCaylakEntersDivan} from "../bildirim/mod-emitters.ts";
import {notifyContentVote} from "../bildirim/vote-emitters.ts";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {InsufficientKarma} from "../kunye/errors.ts";
import {gateContentOnKarma} from "../kunye/privilege.ts";
import {currentSandboxViewer, decidePublish, sandboxedAtForAuthor} from "../kunye/sandbox.ts";
import {ownSandboxed} from "../lifecycle/SandboxVisibility.ts";
import {authorDisplayLabel} from "../pasaport/author-label.ts";
import {SelfVoteNotAllowed, VoterNotEligible} from "../vote/errors.ts";
import {Bookmark} from "./Bookmark.ts";
import {
	CommentNotFound,
	CommentValidationErrors,
	PostDeleteFailed,
	PostNotFound,
	PostValidationErrors,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "./errors.ts";
import {PanoFeedCache} from "./feed-cache.ts";
import {CommentId, PostId} from "./ids.ts";
import {panoLive} from "./live.ts";
import {Pano} from "./Pano.ts";
import {toComment, toPost, toPostFromPage} from "./shapers.ts";
import type {Comment, Post} from "./views.ts";
import {CommentView, PostView} from "./views.ts";

const SubmitPostInput = Schema.Struct({
	title: Schema.String,
	url: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.optional(Schema.NullOr(Schema.String)),
	tags: Schema.Array(
		Schema.Struct({
			kind: Schema.String,
			label: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

const SaveDraftInput = Schema.Struct({
	title: Schema.optional(Schema.NullOr(Schema.String)),
	url: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.optional(Schema.NullOr(Schema.String)),
	tags: Schema.optional(
		Schema.Array(
			Schema.Struct({
				kind: Schema.String,
				label: Schema.optional(Schema.NullOr(Schema.String)),
			}),
		),
	),
});

const DiscardDraftInput = Schema.Struct({});

const PostIdInput = Schema.Struct({
	id: PostId,
});

// An off-palette emoji FAILS to decode here, at the wire boundary, so it never reaches
// `Reaction.react` — the rejection is structural, not a service error (#1859).
const ReactToPostInput = Schema.Struct({
	id: PostId,
	emoji: Schema.NullOr(ReactionEmojiSchema),
});

const EditPostInput = Schema.Struct({
	id: PostId,
	title: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.optional(Schema.NullOr(Schema.String)),
});

const AddCommentInput = Schema.Struct({
	postId: PostId,
	parentId: Schema.optional(Schema.NullOr(CommentId)),
	body: Schema.String,
});

const CommentIdInput = Schema.Struct({
	id: CommentId,
});

const ReactToCommentInput = Schema.Struct({
	id: CommentId,
	emoji: Schema.NullOr(ReactionEmojiSchema),
});

const EditCommentInput = Schema.Struct({
	id: CommentId,
	body: Schema.String,
});

const shapePost = (r: {
	postId: string;
	slug?: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	commentCount: number;
	tags: ReadonlyArray<{kind: string; label: string}>;
	createdAt: Date;
	updatedAt?: Date;
	myVote?: boolean | null;
	isSaved?: boolean | null;
	isDraft?: boolean | null;
}): Post =>
	toPost({
		id: r.postId,
		slug: r.slug ?? null,
		title: r.title,
		url: r.url,
		host: r.host,
		body: r.body,
		author: r.authorName,
		authorId: r.authorId,
		score: r.score,
		commentCount: r.commentCount,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt ?? null,
		myVote: r.myVote ?? null,
		isSaved: r.isSaved ?? null,
		isDraft: r.isDraft ?? null,
		tags: r.tags,
	});

// `sandboxed` is REQUIRED, never optional-with-a-default: it is owner-scoped (#4282)
// and these results are also broadcast to the viewer-blind thread topic. Forcing each
// call site to state it keeps a broadcast from inheriting an author's review state.
const shapeComment = (r: {
	commentId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt?: Date;
	myVote?: boolean | null;
	sandboxed: boolean;
}): Comment =>
	toComment({
		id: r.commentId,
		parentId: r.parentId,
		author: r.authorName,
		authorId: r.authorId,
		body: r.body,
		score: r.score,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt ?? null,
		myVote: r.myVote ?? null,
		sandboxed: r.sandboxed,
	});

export const mutations = {
	"post.submit": Fate.mutation(
		{
			input: SubmitPostInput,
			type: PostView,
			error: Schema.Union([Unauthorized, InsufficientKarma, ...PostValidationErrors]),
		},
		Effect.fn("post.submit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const submit = Effect.fn("post.submitBody")(function* () {
				const pano = yield* Pano;
				const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
				const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
				const r = yield* pano.submitPost({
					title: input.title,
					...(input.url ? {url: input.url} : {}),
					...(input.body ? {body: input.body} : {}),
					tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})})),
					authorId: UserId.make(user.id),
					authorName: authorDisplayLabel(user),
					sandboxedAt,
				});
				const post = shapePost({...r, myVote: null});
				// The feed topic is viewer-blind, so a sandboxed node would leak to non-author
				// subscribers — hence the `decidePublish` gate (#1205).
				yield* live.post.feed.prependNode(post.id, {node: post}, decidePublish(sandboxedAt));
				yield* notifyCaylakEntersDivan({authorId: user.id, sandboxedAt});
				return post;
			});
			// Karma floor (#150), dark behind default-off `phoenix-karma-gates`: ON ⇒ the author
			// must be at ≥ −4. A separate axis from the sandbox tier above (reach vs abuse).
			return yield* gateContentOnKarma(submit());
		}),
	),
	"post.saveDraft": Fate.mutation(
		{
			input: SaveDraftInput,
			type: PostView,
			error: Schema.Union([Unauthorized, ...PostValidationErrors]),
		},
		Effect.fn("post.saveDraft")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.saveDraft({
				authorId: UserId.make(user.id),
				authorName: authorDisplayLabel(user),
				...(input.title != null ? {title: input.title} : {}),
				...(input.url != null ? {url: input.url} : {}),
				...(input.body != null ? {body: input.body} : {}),
				...(input.tags
					? {tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})}))}
					: {}),
			});
			const post = shapePost({...r, myVote: null});
			// A draft is private: re-resolve for the author, never prepend to the public topic.
			yield* live.post.update(post.id, {changed: ["isDraft"], data: post});
			return post;
		}),
	),
	"post.discardDraft": Fate.mutation(
		{
			input: DiscardDraftInput,
			type: PostView,
			error: Unauthorized,
		},
		Effect.fn("post.discardDraft")(function* () {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.discardDraft({authorId: UserId.make(user.id)});
			if (!r.postId) return null;
			yield* live.post.delete(r.postId);
			// Id-only eviction ref: the draft row is gone (see post.delete).
			return {__typename: "Post", id: r.postId};
		}),
	),
	"post.vote": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			// Both tier gates are cast-only; `retractVote` needs neither.
			error: Schema.Union([Unauthorized, PostNotFound, VoterNotEligible, SelfVoteNotAllowed]),
		},
		Effect.fn("post.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.voteOnPost({postId: input.id, voterId: UserId.make(user.id)});
			// Re-resolve the affected post via the same batched read `post.save`/`post.unsave`
			// use, so the returned AND published projection carries the real `isSaved` + live
			// author identity. The write result (`VoteOnPostResult`) has neither, and its
			// null-bearing shape clobbered the client cache — and the fanned live frame — of an
			// already-saved post (#2213).
			// The re-read masks on the sandbox dimension, so it must carry the SAME resolved
			// viewer as the read that surfaced this post (#6424). Handed a degraded
			// `{viewerId}`-only viewer it masks out another author's still-sandboxed post — which
			// an opted-in yazar or a moderator can now reach — and the handler answers
			// `PostNotFound` on a write that already committed. Every re-read below that can
			// raise `*NotFound` carries it for the same reason.
			const sandboxViewer = yield* currentSandboxViewer;
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id, sandboxViewer});
			if (!row) {
				return yield* new PostNotFound({postId: input.id, message: `post ${input.id} not found`});
			}
			const post = toPost(row);
			yield* live.post.update(post.id, {changed: ["score"], data: post});
			if (r.changed) {
				yield* notifyContentVote({
					authorId: r.authorId,
					voterId: user.id,
					targetKind: "post",
					targetId: r.postId,
				});
			}
			return post;
		}),
	),
	"post.retractVote": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, PostNotFound]),
		},
		Effect.fn("post.retractVote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			yield* pano.retractPostVote({postId: input.id, voterId: UserId.make(user.id)});
			// Re-resolve like `post.vote` above so the returned/published projection keeps the
			// real `isSaved` + author identity instead of the null-bearing write shape (#2213).
			const sandboxViewer = yield* currentSandboxViewer;
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id, sandboxViewer});
			if (!row) {
				return yield* new PostNotFound({postId: input.id, message: `post ${input.id} not found`});
			}
			const post = toPost(row);
			yield* live.post.update(post.id, {changed: ["score"], data: post});
			return post;
		}),
	),
	// Karma-free and ungated on purpose: any signed-in user, including a çaylak, may
	// react — no `VoterNotEligible` arm, unlike `post.vote` (#1863).
	"post.react": Fate.mutation(
		{
			input: ReactToPostInput,
			type: PostView,
			error: Schema.Union([Unauthorized, PostNotFound]),
		},
		Effect.fn("post.react")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			// Dark-ship gate (ADR 0083). Off ⇒ the react never lands; re-resolve unchanged so
			// the caller's cache stays consistent. A Flagship outage reads `false` = dark.
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PHOENIX_REACTIONS, false).pipe(provideRequestFlags);
			if (!on) {
				const sandboxViewer = yield* currentSandboxViewer;
				const [current] = yield* pano.getPostsByIds([input.id], {
					viewerId: user.id,
					sandboxViewer,
				});
				if (!current) {
					return yield* new PostNotFound({postId: input.id, message: `post ${input.id} not found`});
				}
				return toPost(current);
			}
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.reactToPost({
				postId: input.id,
				userId: UserId.make(user.id),
				emoji: input.emoji,
			});
			const post = toPost(r.post);
			yield* live.post.update(post.id, {changed: ["reactions"], data: post});
			return post;
		}),
	),
	"post.save": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, PostNotFound]),
		},
		Effect.fn("post.save")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const bookmark = yield* Bookmark;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			yield* bookmark.toggle({userId: UserId.make(user.id), postId: input.id, value: true});
			const sandboxViewer = yield* currentSandboxViewer;
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id, sandboxViewer});
			if (!row) {
				return yield* new PostNotFound({postId: input.id, message: `post ${input.id} not found`});
			}
			const post = toPost(row);
			yield* live.post.update(post.id, {changed: ["isSaved"], data: post});
			return post;
		}),
	),
	"post.unsave": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, PostNotFound]),
		},
		Effect.fn("post.unsave")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const bookmark = yield* Bookmark;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			yield* bookmark.toggle({userId: UserId.make(user.id), postId: input.id, value: false});
			const sandboxViewer = yield* currentSandboxViewer;
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id, sandboxViewer});
			if (!row) {
				return yield* new PostNotFound({postId: input.id, message: `post ${input.id} not found`});
			}
			const post = toPost(row);
			yield* live.post.update(post.id, {changed: ["isSaved"], data: post});
			return post;
		}),
	),
	"post.edit": Fate.mutation(
		{
			input: EditPostInput,
			type: PostView,
			error: Schema.Union([
				Unauthorized,
				...PostValidationErrors,
				PostNotFound,
				UnauthorizedPostMutation,
			]),
		},
		Effect.fn("post.edit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.editPost({
				postId: input.id,
				actorId: UserId.make(user.id),
				...(input.title != null ? {title: input.title} : {}),
				...(input.body != null ? {body: input.body} : {}),
			});
			// Re-read the viewer's vote so the edited entity carries an accurate
			// `myVote` (edit doesn't touch vote state).
			const [fresh] = yield* pano.getPostsByIds([r.postId], {viewerId: user.id});
			const post = shapePost({...r, myVote: fresh?.myVote ?? null});
			yield* live.post.update(post.id, {changed: ["title", "body"], data: post});
			return post;
		}),
	),
	"post.delete": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, UnauthorizedPostMutation, PostDeleteFailed]),
		},
		Effect.fn("post.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			// The removal commit runs over `DrizzleAccessOrDie`, so a D1 write failure DIES as a
			// defect and would escape this union as `INTERNAL_SERVER_ERROR` (#1639).
			const r = yield* pano
				.deletePost({postId: input.id, actorId: UserId.make(user.id)})
				.pipe(
					Effect.catchDefect(
						() => new PostDeleteFailed({message: "Gönderi silinemedi. Lütfen tekrar deneyin."}),
					),
				);
			yield* live.post.delete(r.postId);
			yield* live.post.feed.deleteEdge(r.postId);
			// Bare id-only eviction ref: the post is hidden, so there is no row to shape.
			return {__typename: "Post", id: r.postId};
		}),
	),
	// Restore a removed post (ADR 0096 §4). Re-enters the feed; votes stay wiped.
	"post.restore": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, UnauthorizedPostMutation]),
		},
		Effect.fn("post.restore")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const restored = yield* pano.restorePost({postId: input.id, actorId: UserId.make(user.id)});
			const page = yield* pano.getPost(input.id, {viewerId: user.id});
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(
				page,
				stamped?.myVote ?? null,
				stamped?.isSaved ?? null,
				stamped?.reactions,
				{
					authorUsername: stamped?.authorUsername ?? null,
					authorDisplayName: stamped?.authorDisplayName ?? null,
				},
			);
			// Sandbox-faithful restore (#1811): a sandboxed post round-trips back to sandboxed,
			// so the broadcast goes through `decidePublish`, not an always-live hatch.
			yield* live.post.feed.appendNode(post.id, {node: post}, decidePublish(restored.sandboxedAt));
			return post;
		}),
	),
	"comment.add": Fate.mutation(
		{
			input: AddCommentInput,
			type: CommentView,
			error: Schema.Union([
				Unauthorized,
				InsufficientKarma,
				...CommentValidationErrors,
				PostNotFound,
			]),
		},
		Effect.fn("comment.add")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const add = Effect.fn("comment.addBody")(function* () {
				const pano = yield* Pano;
				const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
				const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
				const r = yield* pano.addComment({
					postId: input.postId,
					authorId: UserId.make(user.id),
					authorName: authorDisplayLabel(user),
					body: input.body,
					sandboxedAt,
					...(input.parentId ? {parentId: input.parentId} : {}),
				});
				// Safe to stamp the owner-scoped flag on the broadcast node: the append below is
				// `decidePublish`-gated, so a `true` node is exactly the one never broadcast (#4282).
				const comment = shapeComment({
					...r,
					myVote: null,
					sandboxed: ownSandboxed({sandboxedAt, authorId: r.authorId}, user.id),
				});
				// The thread topic is viewer-blind, so a sandboxed node would leak to non-author
				// subscribers — hence the `decidePublish` gate (#1205).
				yield* live.comment
					.thread(input.postId)
					.appendNode(comment.id, {node: comment}, decidePublish(sandboxedAt));
				yield* notifyCommentReply({
					commentId: r.commentId,
					postAuthorId: r.postAuthorId,
					parentAuthorId: r.parentAuthorId,
					actorId: user.id,
				});
				yield* notifyCaylakEntersDivan({authorId: user.id, sandboxedAt});
				return comment;
			});
			// Karma floor (#150), dark behind `phoenix-karma-gates` — same as `post.submit`.
			return yield* gateContentOnKarma(add());
		}),
	),
	"comment.vote": Fate.mutation(
		{
			input: CommentIdInput,
			type: CommentView,
			// Both tier gates are cast-only; `retractVote` needs neither.
			error: Schema.Union([Unauthorized, CommentNotFound, VoterNotEligible, SelfVoteNotAllowed]),
		},
		Effect.fn("comment.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.voteOnComment({commentId: input.id, voterId: UserId.make(user.id)});
			// Viewer-blind broadcast payload: a self-vote is rejected, so the voter is never the
			// author and the owner-scoped flag is `false` for them regardless (#4282).
			const comment = shapeComment({...r, sandboxed: false});
			yield* live.comment.update(comment.id, {changed: ["score"], data: comment});
			if (r.changed) {
				yield* notifyContentVote({
					authorId: r.authorId,
					voterId: user.id,
					targetKind: "comment",
					targetId: r.commentId,
				});
			}
			return comment;
		}),
	),
	"comment.retractVote": Fate.mutation(
		{
			input: CommentIdInput,
			type: CommentView,
			error: Schema.Union([Unauthorized, CommentNotFound]),
		},
		Effect.fn("comment.retractVote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.retractCommentVote({
				commentId: input.id,
				voterId: UserId.make(user.id),
			});
			// Viewer-blind broadcast payload — see `comment.vote`.
			const comment = shapeComment({...r, sandboxed: false});
			yield* live.comment.update(comment.id, {changed: ["score"], data: comment});
			return comment;
		}),
	),
	// Karma-free and ungated on purpose: any signed-in user, including a çaylak, may
	// react — no `VoterNotEligible` arm, unlike `comment.vote` (#1864).
	"comment.react": Fate.mutation(
		{
			input: ReactToCommentInput,
			type: CommentView,
			error: Schema.Union([Unauthorized, CommentNotFound]),
		},
		Effect.fn("comment.react")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			// Dark-ship gate (ADR 0083). Off ⇒ the react never lands; re-resolve unchanged so
			// the caller's cache stays consistent. A Flagship outage reads `false` = dark.
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PHOENIX_REACTIONS, false).pipe(provideRequestFlags);
			if (!on) {
				const sandboxViewer = yield* currentSandboxViewer;
				const [current] = yield* pano.getCommentsByIds([input.id], {
					viewerId: user.id,
					sandboxViewer,
				});
				if (!current) {
					return yield* new CommentNotFound({
						commentId: input.id,
						message: `comment ${input.id} not found`,
					});
				}
				return toComment(current);
			}
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.reactToComment({
				commentId: input.id,
				userId: UserId.make(user.id),
				emoji: input.emoji,
			});
			const comment = toComment(r.comment);
			yield* live.comment.update(comment.id, {changed: ["reactions"], data: comment});
			return comment;
		}),
	),
	"comment.edit": Fate.mutation(
		{
			input: EditCommentInput,
			type: CommentView,
			error: Schema.Union([
				Unauthorized,
				...CommentValidationErrors,
				CommentNotFound,
				UnauthorizedCommentMutation,
			]),
		},
		Effect.fn("comment.edit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const r = yield* pano.editComment({
				commentId: input.id,
				actorId: UserId.make(user.id),
				body: input.body,
			});
			const [fresh] = yield* pano.getCommentsByIds([r.commentId], {viewerId: user.id});
			const comment = shapeComment({
				...r,
				myVote: fresh?.myVote ?? null,
				sandboxed: fresh?.sandboxed ?? false,
			});
			// The thread topic is viewer-blind, so the broadcast payload drops the owner-scoped
			// `sandboxed` flag while the author's own returned node keeps it (#4282).
			yield* live.comment.update(comment.id, {
				changed: ["body"],
				data: {...comment, sandboxed: false},
			});
			return comment;
		}),
	),
	"comment.delete": Fate.mutation(
		{
			input: CommentIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, CommentNotFound, UnauthorizedCommentMutation]),
		},
		Effect.fn("comment.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			// Resolve the parent post id before the delete, while the row exists.
			const postId = yield* pano.lookupCommentPostId(input.id);
			const result = yield* pano.deleteComment({
				commentId: input.id,
				actorId: UserId.make(user.id),
			});
			if (!postId) return null;
			const page = yield* pano.getPost(postId, {viewerId: user.id});
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(
				page,
				stamped?.myVote ?? null,
				stamped?.isSaved ?? null,
				stamped?.reactions,
				{
					authorUsername: stamped?.authorUsername ?? null,
					authorDisplayName: stamped?.authorDisplayName ?? null,
				},
			);
			// Removal is always soft (ADR 0096); the reply-aware branch only shapes the live
			// signal. A leaf comment leaves the connection; one with replies must NOT — that
			// would orphan the subtree — so its `[silindi]` tombstone is published in place.
			if (result.placeholder) {
				const placeholder = toComment(result.placeholder);
				yield* live.comment.update(input.id, {
					changed: ["body", "score", "deletedAt", "updatedAt"],
					data: placeholder,
				});
			} else {
				yield* live.comment.thread(post.id).deleteEdge(input.id);
			}
			yield* live.post.update(post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
	// Restore a removed comment (ADR 0096 §4). Votes stay wiped.
	"comment.restore": Fate.mutation(
		{
			input: CommentIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, CommentNotFound, UnauthorizedCommentMutation]),
		},
		Effect.fn("comment.restore")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher, yield* PanoFeedCache);
			const postId = yield* pano.lookupCommentPostId(input.id);
			const restored = yield* pano.restoreComment({
				commentId: input.id,
				actorId: UserId.make(user.id),
			});
			if (!postId) return null;
			const [comment] = yield* pano.getCommentsByIds([input.id], {viewerId: user.id});
			if (comment) {
				const node = toComment(comment);
				// Sandbox-faithful restore (#1811): route the thread broadcast through the
				// #1205 gate so a sandboxed restore is not fanned to the viewer-blind topic.
				yield* live.comment
					.thread(postId)
					.appendNode(node.id, {node}, decidePublish(restored.sandboxedAt ?? null));
			}
			const page = yield* pano.getPost(postId, {viewerId: user.id});
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(
				page,
				stamped?.myVote ?? null,
				stamped?.isSaved ?? null,
				stamped?.reactions,
				{
					authorUsername: stamped?.authorUsername ?? null,
					authorDisplayName: stamped?.authorDisplayName ?? null,
				},
			);
			yield* live.post.update(post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
};
