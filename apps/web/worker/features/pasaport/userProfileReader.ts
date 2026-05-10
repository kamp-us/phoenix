/**
 * Cross-product `user_profile` + contributions feed reader.
 *
 * Powers the GraphQL `profile(username)` query and its `contributions`
 * connection field (T14). The profile page reads:
 *   1. identity row from `user_profile` (joined to Pasaport's user table)
 *   2. live aggregates derived from `definition_view` / `post_summary` /
 *      `comment_view` (filtered by `author_id`, deleted_at IS NULL)
 *   3. an interleaved feed merging the same three view tables, ordered by
 *      `created_at DESC` and paginated by forge ULID cursor.
 *
 * We compute aggregates on-the-fly rather than reading them from
 * `user_profile.*_count` because T13's projection doesn't yet maintain those
 * counters (task_15 is on the hook for it). Deriving from the view tables
 * keeps the profile page correct today and will continue to be correct once
 * the counters land — they'll just be redundant.
 */
import {and, desc, eq, isNull, lt, or, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../view/drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Identity + aggregates                                                       */
/* -------------------------------------------------------------------------- */

export interface ProfileRow {
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
	totalKarma: number;
	definitionCount: number;
	postCount: number;
	commentCount: number;
}

/**
 * Look up a profile by `username`. Returns `null` when no `user_profile` row
 * with that username exists (the GraphQL resolver maps that to a 404 page).
 *
 * Aggregates are computed from the view tables in a single roundtrip via
 * `Promise.all`. Empty-row defaults to 0 across the board.
 */
export async function lookupProfile(d1: D1Database, username: string): Promise<ProfileRow | null> {
	const db = drizzle(d1, {schema});

	const profile = await db
		.select({
			userId: schema.userProfile.userId,
			username: schema.userProfile.username,
			displayName: schema.userProfile.displayName,
			image: schema.userProfile.image,
			totalKarma: schema.userProfile.totalKarma,
		})
		.from(schema.userProfile)
		.where(eq(schema.userProfile.username, username))
		.limit(1);

	const row = profile[0];
	if (!row || row.username == null) return null;

	return await hydrateProfile(d1, {...row, username: row.username});
}

/**
 * Look up a profile by `userId` (the immutable Pasaport user id, not the
 * mutable username). Powers the Relay `node(id)` dispatch — the Profile
 * global id is `Profile:${userId}`, so the resolver decodes and lands here.
 *
 * Returns `null` when the row exists but `username` is still NULL (the user
 * hasn't completed bootstrap) — that profile isn't addressable as a public
 * page yet, mirroring `lookupProfile`'s behavior.
 */
export async function lookupProfileById(
	d1: D1Database,
	userId: string,
): Promise<ProfileRow | null> {
	const db = drizzle(d1, {schema});

	const profile = await db
		.select({
			userId: schema.userProfile.userId,
			username: schema.userProfile.username,
			displayName: schema.userProfile.displayName,
			image: schema.userProfile.image,
			totalKarma: schema.userProfile.totalKarma,
		})
		.from(schema.userProfile)
		.where(eq(schema.userProfile.userId, userId))
		.limit(1);

	const row = profile[0];
	if (!row || row.username == null) return null;

	return await hydrateProfile(d1, {...row, username: row.username});
}

/**
 * Shared aggregate hydration for the two `lookup*` entry points. Counters
 * are derived live from the per-kind view tables (filtered by author and
 * `deleted_at IS NULL`) — same rationale as the file-level docstring.
 */
async function hydrateProfile(
	d1: D1Database,
	row: {
		userId: string;
		username: string;
		displayName: string | null;
		image: string | null;
		totalKarma: number;
	},
): Promise<ProfileRow> {
	const db = drizzle(d1, {schema});
	const authorId = row.userId;
	const [defCount, postCount, commentCount] = await Promise.all([
		db
			.select({n: sql<number>`COUNT(*)`})
			.from(schema.definitionView)
			.where(
				and(eq(schema.definitionView.authorId, authorId), isNull(schema.definitionView.deletedAt)),
			)
			.then((r) => Number(r[0]?.n ?? 0)),
		db
			.select({n: sql<number>`COUNT(*)`})
			.from(schema.postSummary)
			.where(and(eq(schema.postSummary.authorId, authorId), isNull(schema.postSummary.deletedAt)))
			.then((r) => Number(r[0]?.n ?? 0)),
		db
			.select({n: sql<number>`COUNT(*)`})
			.from(schema.commentView)
			.where(and(eq(schema.commentView.authorId, authorId), isNull(schema.commentView.deletedAt)))
			.then((r) => Number(r[0]?.n ?? 0)),
	]);

	return {
		userId: row.userId,
		username: row.username,
		displayName: row.displayName,
		image: row.image,
		totalKarma: row.totalKarma,
		definitionCount: defCount,
		postCount,
		commentCount,
	};
}

/* -------------------------------------------------------------------------- */
/* Contributions feed                                                          */
/* -------------------------------------------------------------------------- */

export type ContributionKind = "definition" | "post" | "comment";

interface DefinitionContributionNode {
	kind: "definition";
	id: string;
	createdAt: Date;
	score: number;
	bodyExcerpt: string;
	termSlug: string;
	termTitle: string;
}

interface PostContributionNode {
	kind: "post";
	id: string;
	createdAt: Date;
	score: number;
	title: string;
	slug: string | null;
	bodyExcerpt: string | null;
}

interface CommentContributionNode {
	kind: "comment";
	id: string;
	createdAt: Date;
	score: number;
	bodyExcerpt: string;
	postId: string;
	postTitle: string;
}

export type ContributionNode =
	| DefinitionContributionNode
	| PostContributionNode
	| CommentContributionNode;

export interface ContributionEdge {
	cursor: string;
	node: ContributionNode;
}

export interface ContributionConnection {
	edges: ContributionEdge[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Cursor format: `${createdAtUnix}:${id}`. We sort the merged stream by
 * `(created_at DESC, id DESC)` — `created_at` is the primary key, `id`
 * (forge ULID) the tie-breaker so the order is total. The cursor encodes
 * both so we can resume the same key without ambiguity.
 */
function encodeCursor(node: {createdAt: Date; id: string}): string {
	return `${Math.floor(node.createdAt.getTime() / 1000)}:${node.id}`;
}

function decodeCursor(cursor: string): {createdAt: Date; id: string} | null {
	const idx = cursor.indexOf(":");
	if (idx < 0) return null;
	const tsRaw = cursor.slice(0, idx);
	const id = cursor.slice(idx + 1);
	const ts = Number(tsRaw);
	if (!Number.isFinite(ts) || !id) return null;
	return {createdAt: new Date(ts * 1000), id};
}

/**
 * Read up to `first` contributions from each of the three view tables, then
 * merge in memory by `(created_at DESC, id DESC)` and trim to `first`. We pull
 * `first + 1` per source so the merged window can still saturate when one
 * source dominates the timeline; cheaper than three increasingly-deep queries.
 *
 * Cursor pagination is keyset: `WHERE created_at < ? OR (created_at = ? AND
 * id < ?)`. SQLite walks the `(author_id, created_at DESC)` indexes forward.
 */
export async function listContributions(
	d1: D1Database,
	args: {authorId: string; after: string | null; first: number},
): Promise<ContributionConnection> {
	const first = Math.max(1, Math.min(args.first, 50));
	const cursor = args.after ? decodeCursor(args.after) : null;
	const cursorTs = cursor ? Math.floor(cursor.createdAt.getTime() / 1000) : null;

	const db = drizzle(d1, {schema});

	const fetchSize = first + 1;

	function keysetWhere<TTable extends {createdAt: any; id: any; authorId: any; deletedAt: any}>(
		table: TTable,
	) {
		const base = and(eq(table.authorId, args.authorId), isNull(table.deletedAt));
		if (cursor && cursorTs != null) {
			return and(
				base,
				or(
					lt(table.createdAt, cursor.createdAt),
					and(eq(table.createdAt, cursor.createdAt), lt(table.id, cursor.id)),
				),
			);
		}
		return base;
	}

	const [defs, posts, comments, totalCount] = await Promise.all([
		db
			.select({
				id: schema.definitionView.id,
				createdAt: schema.definitionView.createdAt,
				score: schema.definitionView.score,
				bodyExcerpt: schema.definitionView.bodyExcerpt,
				termSlug: schema.definitionView.termSlug,
				termTitle: schema.definitionView.termTitle,
			})
			.from(schema.definitionView)
			.where(keysetWhere(schema.definitionView))
			.orderBy(desc(schema.definitionView.createdAt), desc(schema.definitionView.id))
			.limit(fetchSize),
		db
			.select({
				id: schema.postSummary.id,
				slug: schema.postSummary.slug,
				createdAt: schema.postSummary.createdAt,
				score: schema.postSummary.score,
				title: schema.postSummary.title,
				bodyExcerpt: schema.postSummary.bodyExcerpt,
			})
			.from(schema.postSummary)
			.where(keysetWhere(schema.postSummary))
			.orderBy(desc(schema.postSummary.createdAt), desc(schema.postSummary.id))
			.limit(fetchSize),
		db
			.select({
				id: schema.commentView.id,
				createdAt: schema.commentView.createdAt,
				score: schema.commentView.score,
				bodyExcerpt: schema.commentView.bodyExcerpt,
				postId: schema.commentView.postId,
				postTitle: schema.commentView.postTitle,
			})
			.from(schema.commentView)
			.where(keysetWhere(schema.commentView))
			.orderBy(desc(schema.commentView.createdAt), desc(schema.commentView.id))
			.limit(fetchSize),
		// Total contribution count across all three view tables (filtered by
		// author + not-deleted). Independent of cursor — this is the absolute
		// total for the profile, displayed in the page header.
		Promise.all([
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.definitionView)
				.where(
					and(
						eq(schema.definitionView.authorId, args.authorId),
						isNull(schema.definitionView.deletedAt),
					),
				)
				.then((r) => Number(r[0]?.n ?? 0)),
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.postSummary)
				.where(
					and(
						eq(schema.postSummary.authorId, args.authorId),
						isNull(schema.postSummary.deletedAt),
					),
				)
				.then((r) => Number(r[0]?.n ?? 0)),
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.commentView)
				.where(
					and(
						eq(schema.commentView.authorId, args.authorId),
						isNull(schema.commentView.deletedAt),
					),
				)
				.then((r) => Number(r[0]?.n ?? 0)),
		]).then(([d, p, c]) => d + p + c),
	]);

	const merged: ContributionNode[] = [
		...defs.map<ContributionNode>((d) => ({
			kind: "definition",
			id: d.id,
			createdAt: d.createdAt ?? new Date(0),
			score: d.score,
			bodyExcerpt: d.bodyExcerpt,
			termSlug: d.termSlug,
			termTitle: d.termTitle,
		})),
		...posts.map<ContributionNode>((p) => ({
			kind: "post",
			id: p.id,
			createdAt: p.createdAt ?? new Date(0),
			score: p.score,
			title: p.title,
			slug: p.slug,
			bodyExcerpt: p.bodyExcerpt,
		})),
		...comments.map<ContributionNode>((c) => ({
			kind: "comment",
			id: c.id,
			createdAt: c.createdAt ?? new Date(0),
			score: c.score,
			bodyExcerpt: c.bodyExcerpt,
			postId: c.postId,
			postTitle: c.postTitle,
		})),
	];

	merged.sort((a, b) => {
		const aTs = a.createdAt.getTime();
		const bTs = b.createdAt.getTime();
		if (aTs !== bTs) return bTs - aTs;
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});

	const sliced = merged.slice(0, first);
	// hasNextPage is true if either: the merged set overflowed `first`, OR any
	// individual source returned its full `fetchSize` window (we may have left
	// rows in that source past the merge boundary).
	const hasNextPage =
		merged.length > first ||
		defs.length === fetchSize ||
		posts.length === fetchSize ||
		comments.length === fetchSize;

	const last = sliced[sliced.length - 1];
	const endCursor = last ? encodeCursor(last) : null;

	return {
		edges: sliced.map((node) => ({cursor: encodeCursor(node), node})),
		hasNextPage: hasNextPage && sliced.length > 0,
		endCursor,
		totalCount,
	};
}
