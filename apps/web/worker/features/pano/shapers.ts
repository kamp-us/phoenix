/**
 * Pano wire-entity shapers — `Post` / `Comment`. Every `{__typename, …}` literal
 * is built here once so the read/list/write paths can't drift. Shapers take
 * already-resolved field values, not service rows: each source (`PostPage`,
 * `PostSummaryRow`, a vote result) carries different field names, so that mapping
 * stays at the call site and the shaper owns only the wire shape. See
 * `.patterns/fate-connections.md`, `.patterns/fate-effect-operations.md`.
 */

import type {PostPage} from "./Pano.ts";
import type {Comment, Post} from "./views.ts";

export interface PostFields {
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
	// Summary/keyset rows and fresh writes/votes carry no `updatedAt`; the shaper
	// owns the `updatedAt ?? createdAt` fallback so every path yields the same shape.
	updatedAt?: Date | null;
	myVote?: number | null;
	tags: ReadonlyArray<{kind: string; label: string}>;
}

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
	score: r.score,
	commentCount: r.commentCount,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	myVote: r.myVote ?? null,
	tags: [...r.tags],
});

// The single `PostPage` → `Post` mapping shared by the read resolver
// (`queries.post`) and the delete-refresh (`comment.delete`) so they can't drift.
export const toPostFromPage = (page: PostPage, myVote: number | null): Post =>
	toPost({
		id: page.id,
		slug: page.slug,
		title: page.title,
		url: page.url,
		host: page.host,
		body: page.body,
		author: page.author,
		authorId: page.authorId,
		score: page.score,
		commentCount: page.commentCount,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		myVote,
		tags: page.tags,
	});

export interface CommentFields {
	id: string;
	parentId: string | null;
	author: string;
	authorId: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt?: Date | null;
	deletedAt?: Date | null;
	myVote?: number | null;
}

export const toComment = (r: CommentFields): Comment => ({
	__typename: "Comment",
	id: r.id,
	parentId: r.parentId,
	author: r.author,
	authorId: r.authorId,
	body: r.body,
	score: r.score,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	deletedAt: r.deletedAt ?? null,
	myVote: r.myVote ?? null,
});
