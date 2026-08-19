/**
 * Pano wire-entity shapers — every `{__typename, …}` literal is built here once so
 * the read/list/write paths can't drift. The row→wire NAMING lives in the per-entity
 * column→field maps (`post-fields.ts` / `comment-fields.ts`), never at a call site,
 * so renaming a column reader there carries every site with it.
 */

import {EMPTY_REACTION_AGGREGATE, type ReactionAggregate} from "../reaction/Reaction.ts";
import type {CommentFields} from "./comment-fields.ts";
import type {PostPage} from "./Pano.ts";
import type {PostFields} from "./post-fields.ts";
import type {Comment, Post} from "./views.ts";

export type {CommentFields, PostFields};

export const toPost = (r: PostFields): Post => ({
	__typename: "Post",
	id: r.id,
	slug: r.slug,
	title: r.title,
	url: r.url,
	host: r.host,
	body: r.body,
	author: r.author,
	authorId: r.authorId,
	authorUsername: r.authorUsername ?? null,
	authorDisplayName: r.authorDisplayName ?? null,
	score: r.score,
	commentCount: r.commentCount,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	myVote: r.myVote ?? null,
	isSaved: r.isSaved ?? null,
	isDraft: r.isDraft ?? null,
	sandboxed: r.sandboxed ?? false,
	reactions: r.reactions ?? EMPTY_REACTION_AGGREGATE,
	tags: [...r.tags],
});

/**
 * The viewer-invariant BASE post: the cacheable base feed serves this, so its bytes
 * must be identical for anon and every signed-in viewer. `sandboxed` stays but is
 * structurally `false` here (the base route reads the ANONYMOUS sandbox viewer), so
 * it carries no viewer-derived value; the real per-viewer scalars ride the separate
 * authed `PostOverlay` read.
 */
export type BasePost = Omit<Post, "myVote" | "isSaved">;

export const toBasePost = (r: PostFields): BasePost => {
	const {myVote: _myVote, isSaved: _isSaved, ...base} = toPost(r);
	return base;
};

// A `PostPage` row carries no viewer scalar, aggregate, nor resolved identity, so the
// caller threads each in. Callers that don't hydrate `identity` get nulls, and
// `actorLabel` degrades on the client.
export const toPostFromPage = (
	page: PostPage,
	myVote: boolean | null,
	isSaved: boolean | null = null,
	reactions: ReactionAggregate = EMPTY_REACTION_AGGREGATE,
	identity: {authorUsername?: string | null; authorDisplayName?: string | null} = {},
	sandboxed = false,
): Post =>
	toPost({
		id: page.id,
		slug: page.slug,
		title: page.title,
		url: page.url,
		host: page.host,
		body: page.body,
		author: page.author,
		authorId: page.authorId,
		authorUsername: identity.authorUsername ?? null,
		authorDisplayName: identity.authorDisplayName ?? null,
		score: page.score,
		commentCount: page.commentCount,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		myVote,
		isSaved,
		sandboxed,
		reactions,
		tags: page.tags,
	});

export const toComment = (r: CommentFields): Comment => ({
	__typename: "Comment",
	id: r.id,
	parentId: r.parentId,
	author: r.author,
	authorId: r.authorId,
	authorUsername: r.authorUsername ?? null,
	authorDisplayName: r.authorDisplayName ?? null,
	body: r.body,
	score: r.score,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	deletedAt: r.deletedAt ?? null,
	myVote: r.myVote ?? null,
	sandboxed: r.sandboxed ?? false,
	reactions: r.reactions ?? EMPTY_REACTION_AGGREGATE,
});
