/**
 * Pano mutation resolvers — the post + comment write path.
 *
 * Per ADR 0020, mutations are `Fate.mutation` def + `Effect.fn` pairs named
 * `entity.verb` (`.patterns/fate-effect-operations.md`). Each calls a `Pano`
 * service method, then returns the **re-resolved affected entity** shaped
 * exactly like a read. A `comment.delete` returns the re-resolved **parent
 * `Post`** so the client's normalized cache updates the surrounding comment
 * thread; a `post.delete` returns the deleted post's `{id}` (a post has no
 * parent — the client evicts it by id).
 *
 * Input Schemas carry the wire field shapes only — domain validation stays in
 * the service (ADR 0013); domain failures (the `PostValidation` /
 * `CommentValidation` per-code classes, `PostNotFound`, `CommentNotFound`,
 * `UnauthorizedPostMutation`, `UnauthorizedCommentMutation`) are declared on
 * each definition and surface through their `ErrorCode` annotations as
 * stable wire codes (`.patterns/fate-effect-wire-errors.md`). Infra failures
 * never reach this layer — they die inside the domain service (the boundary
 * rule in `.patterns/feature-services.md`).
 *
 * `CurrentUser.required` gates every write (anonymous → `UNAUTHORIZED`). The
 * vote mutations stamp `myVote` authoritatively from the vote write so the
 * field is correct without a follow-up `user_vote` read.
 *
 * Live publishes go through the typo-gated `WorkerLivePublisher` accessor
 * (`fate-live/protocol.ts`) — every publish method's error
 * channel is `never`, so a failed publish can never fail the mutation
 * (`.patterns/fate-effect-server.md`).
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

/**
 * The `Pano` write results name the id `postId`/`commentId` and the author
 * `authorName`; the shapers take the wire field names, so map those keys here
 * before shaping. `slug` is `null` on a write result (the detail read carries
 * it); `updatedAt` falls back to `createdAt` inside `toPost`/`toComment`.
 */
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
			// Fresh write: not yet voted by anyone.
			const post = shapePost({...r, myVote: null});
			// New post leads the feed: prepend its node to the `posts` connection
			// (every feed-sort variant, via the global topic). Inline node, no DB work.
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
			// `myVote` (edit doesn't change vote state).
			const [fresh] = yield* pano.getPostsByIds([r.postId], {viewerId: user.id});
			const post = shapePost({...r, myVote: fresh?.myVote ?? null});
			yield* live.update("Post", post.id, {changed: ["title", "body"], data: post});
			return post;
		}),
	),
	"post.delete": Fate.mutation(
		{
			// A post has no parent entity; return the deleted post's id so the client
			// evicts it by id.
			input: PostIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, UnauthorizedPostMutation]),
		},
		Effect.fn("post.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = yield* WorkerLivePublisher;
			const r = yield* pano.deletePost({postId: input.id, actorId: user.id});
			// Entity gone; drop its edge from the `posts` feed connection.
			yield* live.delete("Post", r.postId);
			yield* live.connection("posts").deleteEdge("Post", r.postId);
			// Not an entity shape — the post is gone; this is an id-only eviction
			// ref (`{__typename, id}`) the client uses to drop the record. There is
			// no row left to run through `toPost`, so it stays a bare ref.
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
			// New comment joins the post's thread: append its node to the
			// `Post.comments` connection keyed by the parent post id. Inline node.
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
			// A delete returns the re-resolved **parent `Post`** so the client's
			// normalized cache updates the surrounding comment thread (ADR 0020).
			// Reply-aware soft-delete vs hard-delete is handled inside the service;
			// the parent post's `commentCount` reflects the result.
			input: CommentIdInput,
			type: PostView,
			error: Schema.Union([Unauthorized, CommentNotFound, UnauthorizedCommentMutation]),
		},
		Effect.fn("comment.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pano = yield* Pano;
			const live = yield* WorkerLivePublisher;
			// Resolve the parent post id before the delete (the row still exists).
			const postId = yield* pano.lookupCommentPostId(input.id);
			const result = yield* pano.deleteComment({commentId: input.id, actorId: user.id});
			if (!postId) return null;
			const page = yield* pano.getPost(postId);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			const post = toPostFromPage(page, stamped?.myVote ?? null);
			// Two delete shapes, driven by the service's reply-aware decision:
			//  - hard delete (leaf): the row is gone, so drop its edge from the
			//    `Post.comments` connection — `deleteEdge` removes it from every open
			//    thread, the author's own included, without a reload.
			//  - soft delete (has replies): the row stays as a `[silindi]` tombstone so
			//    the live replies keep their parent. The edge must NOT leave the
			//    connection (that would orphan the subtree); instead publish the
			//    re-resolved tombstoned comment so each thread re-renders it in place.
			if (result.placeholder) {
				const placeholder = toComment(result.placeholder);
				yield* live.update("Comment", input.id, {
					changed: ["body", "score", "deletedAt", "updatedAt"],
					data: placeholder,
				});
			} else {
				yield* live.connection("Post.comments", {id: post.id}).deleteEdge("Comment", input.id);
			}
			// Either way the parent post's `commentCount` changes — publish the
			// re-resolved parent.
			yield* live.update("Post", post.id, {changed: ["commentCount"], data: post});
			return post;
		}),
	),
};
