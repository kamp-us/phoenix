/**
 * Pano mutation resolvers — the post + comment write path. Per ADR 0020, each
 * calls a `Pano` method then returns the **re-resolved affected entity** shaped
 * like a read: `comment.delete` returns the parent `Post` (so the cache updates
 * the surrounding thread); `post.delete` returns the deleted post's `{id}` (a
 * post has no parent — evict by id). Domain validation stays in the service
 * (ADR 0013); infra failures die there, never reaching this layer.
 *
 * `CurrentUser.required` gates every write (anonymous → `UNAUTHORIZED`). Live
 * publishes go through `WorkerLivePublisher`, whose every method's error channel
 * is `never` — a failed publish can never fail the mutation
 * (`.patterns/fate-effect-server.md`). See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {PANO_DRAFT_SAVE} from "../flagship/resources.ts";
import {decidePublish, sandboxedAtForAuthor} from "../kunye/sandbox.ts";
import {Bookmark} from "./Bookmark.ts";
import {
	CommentNotFound,
	CommentValidationErrors,
	DraftsDisabled,
	PostDeleteFailed,
	PostNotFound,
	PostValidationErrors,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "./errors.ts";
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
	id: Schema.String,
});

const EditPostInput = Schema.Struct({
	id: Schema.String,
	title: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.optional(Schema.NullOr(Schema.String)),
});

const AddCommentInput = Schema.Struct({
	postId: Schema.String,
	parentId: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.String,
});

const CommentIdInput = Schema.Struct({
	id: Schema.String,
});

const EditCommentInput = Schema.Struct({
	id: Schema.String,
	body: Schema.String,
});

// `Pano` write results name the id `postId`/`commentId` and the author
// `authorName`, so map those keys to the shapers' wire field names. `slug` is
// `null` on a write result (the detail read carries it).
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
	});

export const mutations = {
	"post.submit": Fate.mutation(
		{
			input: SubmitPostInput,
			type: PostView,
			error: Schema.Union([Unauthorized, ...PostValidationErrors]),
		},
		Effect.fn("post.submit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			// A çaylak's new post lands sandboxed when the authorship-loop flag is on;
			// flag-off / yazar ⇒ live, exactly as today (#1205).
			const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
			const r = yield* pano.submitPost({
				title: input.title,
				...(input.url ? {url: input.url} : {}),
				...(input.body ? {body: input.body} : {}),
				tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})})),
				authorId: user.id,
				authorName: user.name ?? user.email,
				sandboxedAt,
			});
			const post = shapePost({...r, myVote: null});
			// New post leads the feed: prepend to the `posts` topic (every
			// feed-sort variant, via the global topic). Inline node, no DB work —
			// but only when the post is live: the feed topic is viewer-blind, so a
			// sandboxed node would leak to non-author/anonymous subscribers (#1205 AC#2).
			yield* live.post.feed.prependNode(post.id, {node: post}, decidePublish(sandboxedAt));
			return post;
		}),
	),
	// `post.saveDraft` / `post.discardDraft` are the dark-shipped taslak path (#746),
	// gated server-side on `pano-draft-save` (default-off). The gate is load-bearing:
	// with the flag off both fail `DraftsDisabled` so the path is unreachable even if a
	// client bypasses the UI. The flag context is derived from the signed-in user (the
	// `CurrentUser.required` identity), so a flip can target by user/percentage later.
	"post.saveDraft": Fate.mutation(
		{
			input: SaveDraftInput,
			type: PostView,
			error: Schema.Union([Unauthorized, DraftsDisabled, ...PostValidationErrors]),
		},
		Effect.fn("post.saveDraft")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PANO_DRAFT_SAVE, false).pipe(provideRequestFlags);
			if (!on) {
				return yield* new DraftsDisabled({message: "taslak özelliği şu an kapalı"});
			}
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.saveDraft({
				authorId: user.id,
				authorName: user.name ?? user.email,
				...(input.title != null ? {title: input.title} : {}),
				...(input.url != null ? {url: input.url} : {}),
				...(input.body != null ? {body: input.body} : {}),
				...(input.tags
					? {tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})}))}
					: {}),
			});
			const post = shapePost({...r, myVote: null});
			// A draft is private: re-resolve the affected entity (so the author's cache
			// updates with `isDraft: true`), but never prepend it to the public `posts`
			// topic.
			yield* live.post.update(post.id, {changed: ["isDraft"], data: post});
			return post;
		}),
	),
	"post.discardDraft": Fate.mutation(
		{
			input: DiscardDraftInput,
			type: PostView,
			error: Schema.Union([Unauthorized, DraftsDisabled]),
		},
		Effect.fn("post.discardDraft")(function* () {
			const user = yield* CurrentUser.required;
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PANO_DRAFT_SAVE, false).pipe(provideRequestFlags);
			if (!on) {
				return yield* new DraftsDisabled({message: "taslak özelliği şu an kapalı"});
			}
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.discardDraft({authorId: user.id});
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
			error: Schema.Union([Unauthorized, PostNotFound]),
		},
		Effect.fn("post.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.voteOnPost({postId: input.id, voterId: user.id});
			const post = shapePost(r);
			yield* live.post.update(post.id, {changed: ["score"], data: post});
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
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.retractPostVote({postId: input.id, voterId: user.id});
			const post = shapePost(r);
			yield* live.post.update(post.id, {changed: ["score"], data: post});
			return post;
		}),
	),
	// `post.save` / `post.unsave` mirror `post.vote` / `post.retractVote`: gate on a
	// signed-in viewer, toggle the bookmark (idempotent in the service), then
	// re-resolve the post via the same batched `getPostsByIds` read so the returned
	// entity carries an accurate, freshly-stamped `isSaved`. `live.update` flips
	// every open card. Both reject a missing/deleted post with `POST_NOT_FOUND`
	// (raised by `Bookmark.toggle`).
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
			const live = panoLive(yield* WorkerLivePublisher);
			yield* bookmark.toggle({userId: user.id, postId: input.id, value: true});
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id});
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
			const live = panoLive(yield* WorkerLivePublisher);
			yield* bookmark.toggle({userId: user.id, postId: input.id, value: false});
			const [row] = yield* pano.getPostsByIds([input.id], {viewerId: user.id});
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
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.editPost({
				postId: input.id,
				actorId: user.id,
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
			const live = panoLive(yield* WorkerLivePublisher);
			// The removal commit runs over `DrizzleAccessOrDie` — a D1-layer write failure
			// dies as a defect, which would escape this union as a raw `INTERNAL_SERVER_ERROR`
			// (#1639). Catch that defect into the declared, user-readable `PostDeleteFailed`;
			// the typed `UnauthorizedPostMutation` (a failure, not a defect) passes through.
			const r = yield* pano
				.deletePost({postId: input.id, actorId: user.id})
				.pipe(
					Effect.catchDefect(
						() => new PostDeleteFailed({message: "Gönderi silinemedi. Lütfen tekrar deneyin."}),
					),
				);
			yield* live.post.delete(r.postId);
			yield* live.post.feed.deleteEdge(r.postId);
			// Bare id-only eviction ref: the post is hidden, so there's no row to run
			// through `toPost` and it stays a `{__typename, id}` the client drops.
			return {__typename: "Post", id: r.postId};
		}),
	),
	// Restore (un-delete) a removed post (ADR 0096 §4). Re-enters the feed; votes
	// stay wiped (score 0). Returns the re-resolved `Post`.
	"post.restore": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, UnauthorizedPostMutation]),
		},
		Effect.fn("post.restore")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const restored = yield* pano.restorePost({postId: input.id, actorId: user.id});
			const page = yield* pano.getPost(input.id);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(page, stamped?.myVote ?? null, stamped?.isSaved ?? null);
			// Sandbox-faithful restore (#1811): a çaylak's sandboxed post round-trips
			// back to Sandboxed, so route the broadcast through the #1205/#1280 gate
			// (decidePublish) instead of the always-Live hatch — a sandboxed restore is
			// suppressed from the public feed; a Live restore broadcasts as before.
			yield* live.post.feed.appendNode(post.id, {node: post}, decidePublish(restored.sandboxedAt));
			return post;
		}),
	),
	"comment.add": Fate.mutation(
		{
			input: AddCommentInput,
			type: CommentView,
			error: Schema.Union([Unauthorized, ...CommentValidationErrors, PostNotFound]),
		},
		Effect.fn("comment.add")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			// A çaylak's new comment lands sandboxed when the authorship-loop flag is
			// on; flag-off / yazar ⇒ live, exactly as today (#1205).
			const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
			const r = yield* pano.addComment({
				postId: input.postId,
				authorId: user.id,
				authorName: user.name ?? user.email,
				body: input.body,
				sandboxedAt,
				...(input.parentId ? {parentId: input.parentId} : {}),
			});
			const comment = shapeComment({...r, myVote: null});
			// Append to the `Post.comments` topic keyed by the parent post id — but
			// only when the comment is live: the thread topic is viewer-blind, so a
			// sandboxed node would leak to non-author/anonymous subscribers (#1205 AC#2).
			yield* live.comment
				.thread(input.postId)
				.appendNode(comment.id, {node: comment}, decidePublish(sandboxedAt));
			return comment;
		}),
	),
	"comment.vote": Fate.mutation(
		{
			input: CommentIdInput,
			type: CommentView,
			error: Schema.Union([Unauthorized, CommentNotFound]),
		},
		Effect.fn("comment.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.voteOnComment({commentId: input.id, voterId: user.id});
			const comment = shapeComment(r);
			yield* live.comment.update(comment.id, {changed: ["score"], data: comment});
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
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.retractCommentVote({commentId: input.id, voterId: user.id});
			const comment = shapeComment(r);
			yield* live.comment.update(comment.id, {changed: ["score"], data: comment});
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
			const live = panoLive(yield* WorkerLivePublisher);
			const r = yield* pano.editComment({commentId: input.id, actorId: user.id, body: input.body});
			const [fresh] = yield* pano.getCommentsByIds([r.commentId], {viewerId: user.id});
			const comment = shapeComment({...r, myVote: fresh?.myVote ?? null});
			yield* live.comment.update(comment.id, {changed: ["body"], data: comment});
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
			const live = panoLive(yield* WorkerLivePublisher);
			// Resolve the parent post id before the delete, while the row exists.
			const postId = yield* pano.lookupCommentPostId(input.id);
			const result = yield* pano.deleteComment({commentId: input.id, actorId: user.id});
			if (!postId) return null;
			const page = yield* pano.getPost(postId);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(page, stamped?.myVote ?? null, stamped?.isSaved ?? null);
			// Removal is always soft now (ADR 0096); the reply-aware decision only
			// shapes the live signal:
			//  - leaf (no replies): the service returns no placeholder, so `deleteEdge`
			//    drops it from every open `Post.comments` thread without a reload.
			//  - has replies: the row stays as a `[silindi]` tombstone (view-rendered).
			//    The edge must NOT leave the connection — that would orphan the subtree;
			//    instead publish the tombstoned comment so threads re-render it in place.
			if (result.placeholder) {
				const placeholder = toComment(result.placeholder);
				yield* live.comment.update(input.id, {
					changed: ["body", "score", "deletedAt", "updatedAt"],
					data: placeholder,
				});
			} else {
				yield* live.comment.thread(post.id).deleteEdge(input.id);
			}
			// Either way the parent post's `commentCount` changes — publish it.
			yield* live.post.update(post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
	// Restore (un-delete) a removed comment (ADR 0096 §4). Re-appends it to the
	// thread; votes stay wiped. Returns the re-resolved parent `Post`.
	"comment.restore": Fate.mutation(
		{
			input: CommentIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, CommentNotFound, UnauthorizedCommentMutation]),
		},
		Effect.fn("comment.restore")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = panoLive(yield* WorkerLivePublisher);
			const postId = yield* pano.lookupCommentPostId(input.id);
			const restored = yield* pano.restoreComment({commentId: input.id, actorId: user.id});
			if (!postId) return null;
			const [comment] = yield* pano.getCommentsByIds([input.id], {viewerId: user.id});
			if (comment) {
				const node = toComment(comment);
				// Sandbox-faithful restore (#1811): a çaylak's sandboxed comment round-trips
				// back to Sandboxed, so route the thread broadcast through the #1205/#1280
				// gate — a sandboxed restore is suppressed from the viewer-blind thread
				// topic; a Live restore broadcasts as before.
				yield* live.comment
					.thread(postId)
					.appendNode(node.id, {node}, decidePublish(restored.sandboxedAt ?? null));
			}
			const page = yield* pano.getPost(postId);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(page, stamped?.myVote ?? null, stamped?.isSaved ?? null);
			yield* live.post.update(post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
};
