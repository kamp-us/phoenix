/**
 * Pano mutation resolvers — the post + comment write path.
 *
 * Per ADR 0020, mutations are `{type, input?, resolve: fateMutation(...)}`,
 * named `entity.verb`. Each calls a `Pano` service method, then returns the
 * **re-resolved affected entity** shaped exactly like a read. A `comment.delete`
 * returns the re-resolved **parent `Post`** so the client's normalized cache
 * updates the surrounding comment thread; a `post.delete` returns the deleted
 * post's `{id}` (a post has no parent — the client evicts it by id, matching the
 * GraphQL `@deleteRecord` semantics).
 *
 * Validation stays in the service (ADR 0013) — the resolvers carry no `input`
 * schema beyond fate's thin boundary coercion; domain failures
 * (`PostValidation`, `CommentValidation`, `PostNotFound`, `CommentNotFound`,
 * `UnauthorizedPostMutation`, `UnauthorizedCommentMutation`) surface through the
 * bridge's `encodeFateError` with the same wire codes as the GraphQL path.
 *
 * `Auth.required` gates every write (anonymous → `UNAUTHORIZED`). The vote
 * mutations stamp `myVote` authoritatively from the vote write so the field is
 * correct without a follow-up `user_vote` read.
 *
 * Kept in its own module (not merged into `mutations.ts`) so the inferred
 * `typeof panoMutations` stays nameable across the `fateServer` export (TS4023 —
 * the task_1/2 lesson); the exported input interfaces below are part of that.
 *
 * See `.patterns/fate-mutations.md`, `.patterns/fate-effect-bridge.md`.
 */

import {Pano} from "../features/pano/Pano";
import {Auth} from "../services";
import {fateMutation} from "./effect";
import type {Comment, Post} from "./views";

export interface SubmitPostInput {
	title: string;
	url?: string | null;
	body?: string | null;
	tags: ReadonlyArray<{kind: string; label?: string | null}>;
}
export interface PostIdInput {
	id: string;
}
export interface EditPostInput {
	id: string;
	title?: string | null;
	body?: string | null;
}
export interface AddCommentInput {
	postId: string;
	parentId?: string | null;
	body: string;
}
export interface CommentIdInput {
	id: string;
}
export interface EditCommentInput {
	id: string;
	body: string;
}

/** Shape a `submitPost` / `editPost` / vote result into the `Post` wire entity. */
const toPost = (r: {
	postId: string;
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
}): Post => ({
	__typename: "Post",
	id: r.postId,
	slug: null,
	title: r.title,
	url: r.url,
	host: r.host,
	body: r.body,
	author: r.authorName,
	authorId: r.authorId,
	score: r.score,
	commentCount: r.commentCount,
	createdAt: r.createdAt,
	// Fresh writes/votes don't reshape updatedAt; mirror createdAt (= GraphQL).
	updatedAt: r.updatedAt ?? r.createdAt,
	myVote: r.myVote ?? null,
	tags: [...r.tags],
});

/** Shape an `addComment` / `editComment` / vote result into the `Comment` wire entity. */
const toComment = (r: {
	commentId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt?: Date;
	myVote?: number | null;
}): Comment => ({
	__typename: "Comment",
	id: r.commentId,
	parentId: r.parentId,
	author: r.authorName,
	authorId: r.authorId,
	body: r.body,
	score: r.score,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	deletedAt: null,
	myVote: r.myVote ?? null,
});

export const panoMutations = {
	"post.submit": {
		type: "Post",
		resolve: fateMutation<SubmitPostInput, Post>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.submitPost({
				title: input.title,
				...(input.url ? {url: input.url} : {}),
				...(input.body ? {body: input.body} : {}),
				tags: input.tags.map((t) => ({kind: t.kind, ...(t.label ? {label: t.label} : {})})),
				authorId: user.id,
				authorName: user.name ?? user.email,
			});
			// Fresh write: not yet voted by anyone.
			return toPost({...r, myVote: null});
		}),
	},
	"post.vote": {
		type: "Post",
		resolve: fateMutation<PostIdInput, Post>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.voteOnPost({postId: input.id, voterId: user.id});
			return toPost(r);
		}),
	},
	"post.retractVote": {
		type: "Post",
		resolve: fateMutation<PostIdInput, Post>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.retractPostVote({postId: input.id, voterId: user.id});
			return toPost(r);
		}),
	},
	"post.edit": {
		type: "Post",
		resolve: fateMutation<EditPostInput, Post>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.editPost({
				postId: input.id,
				actorId: user.id,
				...(input.title != null ? {title: input.title} : {}),
				...(input.body != null ? {body: input.body} : {}),
			});
			// Re-read the viewer's vote so the edited entity carries an accurate
			// `myVote` (edit doesn't change vote state).
			const [fresh] = yield* pano.getPostsByIds([r.postId], {viewerId: user.id});
			return toPost({...r, myVote: fresh?.myVote ?? null});
		}),
	},
	"post.delete": {
		// A post has no parent entity; return the deleted post's id so the client
		// evicts it by id (matching the GraphQL `@deleteRecord` on the global id).
		type: "Post",
		resolve: fateMutation<PostIdInput, {__typename: "Post"; id: string}>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.deletePost({postId: input.id, actorId: user.id});
			return {__typename: "Post", id: r.postId};
		}),
	},
	"comment.add": {
		type: "Comment",
		resolve: fateMutation<AddCommentInput, Comment>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.addComment({
				postId: input.postId,
				authorId: user.id,
				authorName: user.name ?? user.email,
				body: input.body,
				...(input.parentId ? {parentId: input.parentId} : {}),
			});
			return toComment({...r, myVote: null});
		}),
	},
	"comment.vote": {
		type: "Comment",
		resolve: fateMutation<CommentIdInput, Comment>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.voteOnComment({commentId: input.id, voterId: user.id});
			return toComment(r);
		}),
	},
	"comment.retractVote": {
		type: "Comment",
		resolve: fateMutation<CommentIdInput, Comment>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.retractCommentVote({commentId: input.id, voterId: user.id});
			return toComment(r);
		}),
	},
	"comment.edit": {
		type: "Comment",
		resolve: fateMutation<EditCommentInput, Comment>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			const r = yield* pano.editComment({commentId: input.id, actorId: user.id, body: input.body});
			const [fresh] = yield* pano.getCommentsByIds([r.commentId], {viewerId: user.id});
			return toComment({...r, myVote: fresh?.myVote ?? null});
		}),
	},
	"comment.delete": {
		// A delete returns the re-resolved **parent `Post`** so the client's
		// normalized cache updates the surrounding comment thread (ADR 0020).
		// Reply-aware soft-delete vs hard-delete is handled inside the service; the
		// parent post's `commentCount` reflects the result.
		type: "Post",
		resolve: fateMutation<CommentIdInput, Post | null>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pano = yield* Pano;
			// Resolve the parent post id before the delete (the row still exists).
			const postId = yield* pano.lookupCommentPostId(input.id);
			yield* pano.deleteComment({commentId: input.id, actorId: user.id});
			if (!postId) return null;
			const page = yield* pano.getPost(postId);
			if (!page) return null;
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId: user.id});
			return toPost({
				postId: page.id,
				title: page.title,
				url: page.url,
				host: page.host,
				body: page.body,
				authorId: page.authorId,
				authorName: page.author,
				score: page.score,
				commentCount: page.commentCount,
				tags: page.tags,
				createdAt: page.createdAt,
				updatedAt: page.updatedAt,
				myVote: stamped?.myVote ?? null,
			});
		}),
	},
};
