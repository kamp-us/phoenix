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

import {CurrentUser, Fate, Unauthorized} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {
	CommentNotFound,
	CommentValidationErrors,
	PostNotFound,
	PostValidationErrors,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "./errors.ts";
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
	myVote?: number | null;
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
	myVote?: number | null;
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.submitPost({
				title: input.title,
				...(input.url ? {url: input.url} : {}),
				...(input.body ? {body: input.body} : {}),
				tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})})),
				authorId: user.id,
				authorName: user.name ?? user.email,
			});
			const post = shapePost({...r, myVote: null});
			// New post leads the feed: prepend to the `posts` connection (every
			// feed-sort variant, via the global topic). Inline node, no DB work.
			yield* live.connection("posts").prependNode("Post", post.id, {node: post});
			return post;
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.voteOnPost({postId: input.id, voterId: user.id});
			const post = shapePost(r);
			yield* live.update("Post", post.id, {changed: ["score"], data: post});
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.retractPostVote({postId: input.id, voterId: user.id});
			const post = shapePost(r);
			yield* live.update("Post", post.id, {changed: ["score"], data: post});
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
			const live = yield* WorkerLivePublisher;
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
			yield* live.update("Post", post.id, {changed: ["title", "body"], data: post});
			return post;
		}),
	),
	"post.delete": Fate.mutation(
		{
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, UnauthorizedPostMutation]),
		},
		Effect.fn("post.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.deletePost({postId: input.id, actorId: user.id});
			yield* live.delete("Post", r.postId);
			yield* live.connection("posts").deleteEdge("Post", r.postId);
			// Bare id-only eviction ref: the post is gone, so there's no row to run
			// through `toPost` and it stays a `{__typename, id}` the client drops.
			return {__typename: "Post", id: r.postId};
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.addComment({
				postId: input.postId,
				authorId: user.id,
				authorName: user.name ?? user.email,
				body: input.body,
				...(input.parentId ? {parentId: input.parentId} : {}),
			});
			const comment = shapeComment({...r, myVote: null});
			// Append to the `Post.comments` connection keyed by the parent post id.
			yield* live
				.connection("Post.comments", {id: input.postId})
				.appendNode("Comment", comment.id, {node: comment});
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.voteOnComment({commentId: input.id, voterId: user.id});
			const comment = shapeComment(r);
			yield* live.update("Comment", comment.id, {changed: ["score"], data: comment});
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.retractCommentVote({commentId: input.id, voterId: user.id});
			const comment = shapeComment(r);
			yield* live.update("Comment", comment.id, {changed: ["score"], data: comment});
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
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.editComment({commentId: input.id, actorId: user.id, body: input.body});
			const [fresh] = yield* pano.getCommentsByIds([r.commentId], {viewerId: user.id});
			const comment = shapeComment({...r, myVote: fresh?.myVote ?? null});
			yield* live.update("Comment", comment.id, {changed: ["body"], data: comment});
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
			const live = yield* WorkerLivePublisher;
			// Resolve the parent post id before the delete, while the row exists.
			const postId = yield* pano.lookupCommentPostId(input.id);
			const result = yield* pano.deleteComment({commentId: input.id, actorId: user.id});
			if (!postId) return null;
			const page = yield* pano.getPost(postId);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(page, stamped?.myVote ?? null);
			// Two delete shapes, driven by the service's reply-aware decision (ADR 0024):
			//  - hard delete (leaf): the row is gone, so `deleteEdge` drops it from
			//    every open `Post.comments` thread without a reload.
			//  - soft delete (has replies): the row stays as a `[silindi]` tombstone.
			//    The edge must NOT leave the connection — that would orphan the subtree;
			//    instead publish the tombstoned comment so threads re-render it in place.
			if (result.placeholder) {
				const placeholder = toComment(result.placeholder);
				yield* live.update("Comment", input.id, {
					changed: ["body", "score", "deletedAt", "updatedAt"],
					data: placeholder,
				});
			} else {
				yield* live.connection("Post.comments", {id: post.id}).deleteEdge("Comment", input.id);
			}
			// Either way the parent post's `commentCount` changes — publish it.
			yield* live.update("Post", post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
};
