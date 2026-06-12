/**
 * Pano wire-entity shapers — `Post` / `Comment`.
 *
 * Every `{__typename: "Post" | "Comment", …}` literal is built here, once;
 * resolvers, lists, and mutations call a shaper instead of hand-restating the
 * literal so adding or renaming a field is a one-line edit and the
 * read/list/write paths can never drift out of byte-for-byte agreement.
 *
 * Shapers take already-resolved field values, not service rows — the mapping
 * from a given source row (a `PostPage`, a `PostSummaryRow`, a vote result)
 * onto the wire fields stays at the call site, because each source carries
 * different field names; the shaper owns only the wire shape itself.
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-effect-operations.md`.
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
	/**
	 * Summary/keyset rows and fresh writes/votes carry no `updatedAt`; the shaper
	 * owns the fallback (`updatedAt ?? createdAt`). Detail pages pass a non-null
	 * `updatedAt`, so the fallback is a no-op there — every path yields the same
	 * wire shape.
	 */
	updatedAt?: Date | null;
	myVote?: number | null;
	tags: ReadonlyArray<{kind: string; label: string}>;
}

/** Shape resolved post fields into the `Post` wire entity. */
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

/**
 * Shape a detail `PostPage` (from `Pano.getPost`) plus the viewer's stamped
 * `myVote` onto the `Post` wire entity. The `PostPage` field names already match
 * the wire fields, so this is a direct map; the single mapping shared by the read
 * resolver (`queries.post`) and the delete-refresh (`pano-mutations.comment.delete`)
 * so they can't drift.
 */
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

/** Shape resolved comment fields into the `Comment` wire entity. */
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
