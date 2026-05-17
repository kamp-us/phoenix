/**
 * Read-side helper for the `posts(sort, limit, host)` resolver.
 *
 * Reads from `PHOENIX_DB.post_summary` (maintained inline by the pano writer
 * module per ADR 0009 — no projection layer, no per-post DOs).
 */
import {and, desc, eq, isNull, lt, or, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";

export type PostSort = "hot" | "new" | "top" | "discuss";

/**
 * Page returned by the connection-shaped reader (`listPostConnection`).
 *
 * `endCursor` is `null` when the page is empty or when `hasNextPage` is
 * `false`. Cursor encoding is opaque to the client; today it's just the
 * post id (forge ULID, lex-sortable; matches the `(created_at DESC, id DESC)`
 * key used for the `new` sort).
 */
export interface PostConnectionPage {
	rows: PostSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Mirrors the legacy `PostSummary` shape so the GraphQL `Post` type's
 * resolvers don't need new branches. `tags` is parsed from the comma-
 * separated `tags` column on `post_summary` and rendered as `{kind, label}`
 * pairs (label = kind for now; static enum mapping lives at the resolver
 * layer if richer labels are needed).
 */
export interface PostSummaryRow {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	/** Author's Pasaport user id — powers the frontend's edit/delete gate (T9). */
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	tags: Array<{kind: string; label: string}>;
}

export async function listPostSummaries(
	d1: D1Database,
	opts: {sort?: PostSort; limit?: number; host?: string} = {},
): Promise<PostSummaryRow[]> {
	const sort = opts.sort ?? "hot";
	const limit = opts.limit ?? 50;
	const host = opts.host;
	const db = drizzle(d1, {schema});

	const where = host
		? and(eq(schema.postSummary.host, host), isNull(schema.postSummary.deletedAt))
		: isNull(schema.postSummary.deletedAt);

	const orderBy =
		sort === "new"
			? desc(schema.postSummary.createdAt)
			: sort === "top"
				? desc(schema.postSummary.score)
				: sort === "discuss"
					? desc(schema.postSummary.commentCount)
					: desc(schema.postSummary.hotScore);

	const rows = await db
		.select({
			id: schema.postSummary.id,
			slug: schema.postSummary.slug,
			title: schema.postSummary.title,
			url: schema.postSummary.url,
			host: schema.postSummary.host,
			bodyExcerpt: schema.postSummary.bodyExcerpt,
			authorId: schema.postSummary.authorId,
			authorName: schema.postSummary.authorName,
			score: schema.postSummary.score,
			commentCount: schema.postSummary.commentCount,
			createdAt: schema.postSummary.createdAt,
			tags: schema.postSummary.tags,
		})
		.from(schema.postSummary)
		.where(where)
		.orderBy(orderBy)
		.limit(limit);

	return rows.map((r) => ({
		id: r.id,
		slug: r.slug,
		title: r.title,
		url: r.url,
		host: r.host,
		body: r.bodyExcerpt,
		author: r.authorName,
		authorId: r.authorId,
		score: r.score,
		commentCount: r.commentCount,
		createdAt: r.createdAt ?? new Date(0),
		tags: parseTags(r.tags),
	}));
}

/**
 * Static label map for the fixed tag enum (per PRD: göster / tartışma /
 * soru / söylenme / meta). Falls back to the raw kind so unknown tags still
 * render. Keeping this client-side avoids denormalizing labels into D1.
 */
const TAG_LABELS: Record<string, string> = {
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
	meta: "meta",
};

function parseTags(csv: string): Array<{kind: string; label: string}> {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: TAG_LABELS[kind] ?? kind}));
}

/**
 * Connection-shaped reader for `posts(sort, host, first, after)` (task_2,
 * phoenix-relay-idiom). Cursor is opaque to the client — the post id (forge
 * ULID, lex-sortable). `after` selects rows whose sort-key tuple comes strictly
 * after the cursor's row, with `id` as the deterministic tie-breaker.
 *
 * For `hot`/`top`/`discuss` sorts the primary key is a numeric column
 * (`hot_score`, `score`, `comment_count`); the keyset predicate is
 * `WHERE (key < cursor.key) OR (key = cursor.key AND id < cursor.id)`. For
 * the `new` sort the key is `created_at` (lex-sortable in workers'
 * `unix_epoch_seconds` form), but since the post id itself is a forge ULID,
 * we shortcut to `WHERE id < cursor.id` — same order, half the comparisons.
 *
 * Reads `count(*)` once per page for `totalCount` (the dividend on the
 * `LoadMoreButton`). Acceptable cost for the MVP scale; revisit if the
 * count read shows up on a flame graph.
 */
export async function listPostConnection(
	d1: D1Database,
	opts: {sort?: PostSort; first?: number; after?: string | null; host?: string | null} = {},
): Promise<PostConnectionPage> {
	const sort = opts.sort ?? "hot";
	const first = Math.max(1, Math.min(opts.first ?? 20, 100));
	const after = opts.after ?? null;
	const host = opts.host ?? null;
	const db = drizzle(d1, {schema});

	const baseConditions = [isNull(schema.postSummary.deletedAt)];
	if (host) baseConditions.push(eq(schema.postSummary.host, host));

	// Resolve the cursor row so we can build the keyset predicate. A miss
	// (cursor pointing at a since-deleted post) collapses to "no further
	// rows" — the FE then re-fetches from the head, which is the right
	// behavior for a stale cursor.
	let cursorRow: {
		id: string;
		score: number;
		hotScore: number;
		commentCount: number;
		createdAt: Date | null;
	} | null = null;
	let cursorMissed = false;
	if (after) {
		cursorRow =
			(await db
				.select({
					id: schema.postSummary.id,
					score: schema.postSummary.score,
					hotScore: schema.postSummary.hotScore,
					commentCount: schema.postSummary.commentCount,
					createdAt: schema.postSummary.createdAt,
				})
				.from(schema.postSummary)
				.where(eq(schema.postSummary.id, after))
				.get()) ?? null;
		if (!cursorRow) {
			// Stale cursor (the row was deleted between pages). Collapse to
			// "no further rows" so the FE re-fetches from the head instead
			// of accidentally re-rendering rows the user has already seen.
			cursorMissed = true;
		}
	}
	if (cursorMissed) {
		const totalCountRow = await db
			.select({n: sql<number>`count(*)`})
			.from(schema.postSummary)
			.where(and(...baseConditions))
			.get();
		return {
			rows: [],
			hasNextPage: false,
			endCursor: null,
			totalCount: totalCountRow?.n ?? 0,
		};
	}

	const cursorPredicate = cursorRow
		? sort === "new"
			? lt(schema.postSummary.id, cursorRow.id)
			: sort === "top"
				? or(
						lt(schema.postSummary.score, cursorRow.score),
						and(
							eq(schema.postSummary.score, cursorRow.score),
							lt(schema.postSummary.id, cursorRow.id),
						),
					)
				: sort === "discuss"
					? or(
							lt(schema.postSummary.commentCount, cursorRow.commentCount),
							and(
								eq(schema.postSummary.commentCount, cursorRow.commentCount),
								lt(schema.postSummary.id, cursorRow.id),
							),
						)
					: or(
							lt(schema.postSummary.hotScore, cursorRow.hotScore),
							and(
								eq(schema.postSummary.hotScore, cursorRow.hotScore),
								lt(schema.postSummary.id, cursorRow.id),
							),
						)
		: null;

	const whereExpr = cursorPredicate
		? and(...baseConditions, cursorPredicate)
		: and(...baseConditions);

	const orderBy =
		sort === "new"
			? [desc(schema.postSummary.id)]
			: sort === "top"
				? [desc(schema.postSummary.score), desc(schema.postSummary.id)]
				: sort === "discuss"
					? [desc(schema.postSummary.commentCount), desc(schema.postSummary.id)]
					: [desc(schema.postSummary.hotScore), desc(schema.postSummary.id)];

	// Fetch one extra row to detect `hasNextPage` without a follow-up query.
	const fetched = await db
		.select({
			id: schema.postSummary.id,
			slug: schema.postSummary.slug,
			title: schema.postSummary.title,
			url: schema.postSummary.url,
			host: schema.postSummary.host,
			bodyExcerpt: schema.postSummary.bodyExcerpt,
			authorId: schema.postSummary.authorId,
			authorName: schema.postSummary.authorName,
			score: schema.postSummary.score,
			commentCount: schema.postSummary.commentCount,
			createdAt: schema.postSummary.createdAt,
			tags: schema.postSummary.tags,
		})
		.from(schema.postSummary)
		.where(whereExpr)
		.orderBy(...orderBy)
		.limit(first + 1);

	const hasNextPage = fetched.length > first;
	const sliced = hasNextPage ? fetched.slice(0, first) : fetched;

	const rows: PostSummaryRow[] = sliced.map((r) => ({
		id: r.id,
		slug: r.slug,
		title: r.title,
		url: r.url,
		host: r.host,
		body: r.bodyExcerpt,
		author: r.authorName,
		authorId: r.authorId,
		score: r.score,
		commentCount: r.commentCount,
		createdAt: r.createdAt ?? new Date(0),
		tags: parseTags(r.tags),
	}));

	const totalCountRow = await db
		.select({n: sql<number>`count(*)`})
		.from(schema.postSummary)
		.where(and(...baseConditions))
		.get();
	const totalCount = totalCountRow?.n ?? 0;

	const last = rows.at(-1) ?? null;
	return {
		rows,
		hasNextPage,
		endCursor: last ? last.id : null,
		totalCount,
	};
}
