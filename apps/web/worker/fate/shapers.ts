/**
 * Wire-entity shapers — the single source of fate entity shaping.
 *
 * Every `{__typename: "…", …}` wire literal is built here, once. Resolvers,
 * lists, and mutations call a shaper with the entity's field values (named after
 * the wire fields) instead of hand-restating the literal — so adding or renaming
 * a field on an entity is a one-line edit in one place, and the read/list/write
 * paths can never drift out of byte-for-byte agreement.
 *
 * The connection envelope (`{items, pagination}`) is built once too, by
 * `toConnection`: a generic over the keyset page shape the services return
 * (`{rows, hasNextPage, endCursor}`) plus a per-node shaper. Services page
 * forward only, so `hasPrevious` is always `false` and the cursor is the
 * service keyset (opaque to the client).
 *
 * These shapers take already-resolved field values, not service rows — the
 * mapping from a given source row (a `TermPage`, a `PostSummaryRow`, a vote
 * result) onto the wire fields stays at the call site, because each source
 * carries different field names; the shaper owns only the wire shape itself.
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-mutations.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import type {PostPage} from "../features/pano/Pano.ts";
import {toContributionRow} from "../features/pasaport/Pasaport.ts";
import type {TermPage} from "../features/sozluk/Sozluk.ts";
import type {Comment, Definition, Post, Term, User} from "./views.ts";

export {toContributionRow};

export interface UserFields {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

/** Shape resolved user fields into the `User` wire entity. */
export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
});

export interface TermFields {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
	excerpt: string | null;
	firstAt: Date | null;
	lastEdit: Date | null;
	firstLetter: string;
	definitionCount: number;
	lastActivityAt: Date | null;
}

/**
 * Shape resolved term fields into the `Term` wire entity. `id` === `slug` (the
 * client's normalization key for a term is its slug).
 */
export const toTerm = (r: TermFields): Term => ({
	__typename: "Term",
	id: r.slug,
	slug: r.slug,
	title: r.title,
	count: r.count,
	totalScore: r.totalScore,
	excerpt: r.excerpt,
	firstAt: r.firstAt,
	lastEdit: r.lastEdit,
	firstLetter: r.firstLetter,
	definitionCount: r.definitionCount,
	lastActivityAt: r.lastActivityAt,
});

/**
 * Shape a detail `TermPage` (from `Sozluk.getTerm`) onto the `Term` wire entity.
 * The detail page carries no `excerpt` and derives `firstLetter` from the
 * title/slug; `count`/`definitionCount` both come from `totalDefinitions` and
 * `lastActivityAt` mirrors `lastEdit`. The single mapping shared by the read
 * resolver (`queries.term`) and the delete-refresh (`mutations.definition.delete`)
 * so they can't drift.
 */
export const toTermFromPage = (page: TermPage): Term =>
	toTerm({
		slug: page.slug,
		title: page.title,
		count: page.totalDefinitions,
		totalScore: page.totalScore,
		excerpt: null,
		firstAt: page.firstAt,
		lastEdit: page.lastEdit,
		firstLetter: (page.title?.[0] ?? page.slug.charAt(0) ?? "").toLowerCase(),
		definitionCount: page.totalDefinitions,
		lastActivityAt: page.lastEdit,
	});

export interface DefinitionFields {
	id: string;
	body: string;
	score: number;
	author: string;
	authorId: string;
	createdAt: Date;
	updatedAt: Date;
	myVote?: number | null;
}

/** Shape resolved definition fields into the `Definition` wire entity. */
export const toDefinition = (r: DefinitionFields): Definition => ({
	__typename: "Definition",
	id: r.id,
	body: r.body,
	score: r.score,
	author: r.author,
	authorId: r.authorId,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt,
	myVote: r.myVote ?? null,
});

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

/**
 * A service keyset page: forward-only rows plus the `hasNextPage` flag and the
 * opaque `endCursor`. The shape `toConnection` reshapes onto a `ConnectionResult`.
 */
export interface KeysetPage<Row> {
	rows: ReadonlyArray<Row>;
	hasNextPage: boolean;
	endCursor: string | null;
}

/**
 * Build a `ConnectionResult<Node>` from a service keyset page. `cursor` derives
 * each item's cursor from its source row (usually the keyset key); `node` shapes
 * the row into the wire entity. Services page forward only, so `hasPrevious` is
 * always `false`.
 */
export const toConnection = <Row, Node>(
	page: KeysetPage<Row>,
	cursor: (row: Row) => string,
	node: (row: Row) => Node,
): ConnectionResult<Node> => ({
	items: page.rows.map((row) => ({cursor: cursor(row), node: node(row)})),
	pagination: {
		hasNext: page.hasNextPage,
		hasPrevious: false,
		...(page.endCursor ? {nextCursor: page.endCursor} : {}),
	},
});
