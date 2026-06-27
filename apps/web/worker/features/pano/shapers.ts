/**
 * Pano wire-entity shapers — `Post` / `Comment`. Every `{__typename, …}` literal
 * is built here once so the read/list/write paths can't drift. The wire field set is
 * NOT restated here: `PostFields` / `CommentFields` derive from the one column→field
 * map per entity (`post-fields.ts` / `comment-fields.ts`), so the row mapper, this
 * wire shaper, and the `*View` field list all trace back to a single structure —
 * rename a column reader in the map and every site follows (#1126 AC#1, the Pano
 * parallel of the Definition slice in `sozluk/definition-fields.ts`).
 *
 * The map's keys ARE the wire field names, so a shaper just stamps `__typename` + the
 * `updatedAt ?? createdAt` fallback + the `myVote` / `isSaved` / `isDraft` viewer-scalar
 * defaults onto the map's already-wire-named values; the per-source row→wire NAMING
 * lives in the map, not at each call site. The detail-page / write / vote results that
 * carry their own field names map onto `PostFields` at their call site (`toPostFromPage`,
 * the mutation shapers). See `.patterns/fate-connections.md`,
 * `.patterns/fate-effect-operations.md`.
 */

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
	score: r.score,
	commentCount: r.commentCount,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt ?? r.createdAt,
	myVote: r.myVote ?? null,
	isSaved: r.isSaved ?? null,
	isDraft: r.isDraft ?? null,
	tags: [...r.tags],
});

// The single `PostPage` → `Post` mapping shared by the read resolver
// (`queries.post`) and the delete-refresh (`comment.delete`) so they can't drift.
// `myVote`/`isSaved` are stamped separately (the page row carries neither viewer
// scalar) so the caller threads each in.
export const toPostFromPage = (
	page: PostPage,
	myVote: boolean | null,
	isSaved: boolean | null = null,
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
		score: page.score,
		commentCount: page.commentCount,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		myVote,
		isSaved,
		tags: page.tags,
	});

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
