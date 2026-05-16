/**
 * Read-side helper for the `terms(sort, limit)` resolver.
 *
 * The cross-entity term list reads from `PHOENIX_DB.term_summary` (the MV
 * maintained by `PhoenixProjection.TermChanged`), not from per-term DOs —
 * fanning out to every term DO would be O(n) RPCs per page render.
 *
 * Per-term reads (`term(slug)`) still RPC into `SozlukTerm` for the full
 * page (definitions live there, not in the MV).
 */
import {and, desc, eq, gt, lt, or, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";

export type ListSort = "recent" | "popular";

/**
 * Mirrors the GraphQL `Term` type's resolver expectations. `firstAt` /
 * `lastEdit` are pre-converted to JS Date in the resolver if present.
 *
 * `firstLetter`, `definitionCount`, and `lastActivityAt` are surfaced for
 * the Sozluk home `TermRowFragment` (task_5, phoenix-relay-idiom). They
 * mirror the term_summary columns 1:1 and are nullable on shapes that
 * don't carry them (`TermPage` from per-term DO reads).
 */
export interface TermSummaryRow {
	id: string;
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

export async function listTermSummaries(
	d1: D1Database,
	opts: {sort?: ListSort; limit?: number} = {},
): Promise<TermSummaryRow[]> {
	const sort = opts.sort ?? "recent";
	const limit = opts.limit ?? 50;
	const db = drizzle(d1, {schema});

	const rows = await db
		.select({
			slug: schema.termSummary.slug,
			title: schema.termSummary.title,
			firstLetter: schema.termSummary.firstLetter,
			definitionCount: schema.termSummary.definitionCount,
			totalScore: schema.termSummary.totalScore,
			excerpt: schema.termSummary.excerpt,
			firstAt: schema.termSummary.firstAt,
			lastActivityAt: schema.termSummary.lastActivityAt,
			lastEditAt: schema.termSummary.lastEditAt,
		})
		.from(schema.termSummary)
		.orderBy(
			sort === "popular"
				? desc(schema.termSummary.totalScore)
				: desc(schema.termSummary.lastActivityAt),
		)
		.limit(limit);

	return rows.map((r) => ({
		id: r.slug,
		slug: r.slug,
		title: r.title,
		count: r.definitionCount,
		totalScore: r.totalScore,
		excerpt: r.excerpt ?? null,
		firstAt: r.firstAt,
		lastEdit: r.lastEditAt,
		firstLetter: r.firstLetter,
		definitionCount: r.definitionCount,
		lastActivityAt: r.lastActivityAt,
	}));
}

/**
 * Page returned by the connection-shaped term reader (task_5,
 * phoenix-relay-idiom). Mirrors `PostConnectionPage` from
 * `postSummaryReader.ts`. `endCursor` is `null` on an empty page or when
 * `hasNextPage` is `false`. Cursor encoding is opaque to the client; today
 * it's the term slug — slugs are stable lex-sortable strings and the
 * primary key of `term_summary`, which makes them the cheapest deterministic
 * tie-breaker available for both `recent` and `popular` sort orders.
 */
export interface TermConnectionPage {
	rows: TermSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Connection-shaped reader for `terms(sort, first, after)` (task_5,
 * phoenix-relay-idiom). Cursor is the term slug — `term_summary.slug` is
 * the primary key, so the cursor row resolves with a single point lookup.
 *
 * For both sorts the keyset predicate orders by the sort column DESC with
 * `slug` as the deterministic tie-breaker (ASC, since equal sort keys want
 * a stable secondary order). `recent` sorts on `last_activity_at`;
 * `popular` sorts on `total_score`. A stale cursor (slug deleted since the
 * page rendered) collapses to "no further rows" — the FE re-fetches from
 * the head, the same behavior as `listPostConnection`.
 *
 * Reads `count(*)` once per page for `totalCount` (the dividend on a
 * `LoadMoreButton` if the home grows pagination later — this task ships
 * without one but the connection shape is future-proofed).
 */
export async function listTermSummariesConnection(
	d1: D1Database,
	opts: {sort?: ListSort; first?: number; after?: string | null} = {},
): Promise<TermConnectionPage> {
	const sort = opts.sort ?? "recent";
	const first = Math.max(1, Math.min(opts.first ?? 20, 100));
	const after = opts.after ?? null;
	const db = drizzle(d1, {schema});

	let cursorRow: {
		slug: string;
		totalScore: number;
		lastActivityAt: Date | null;
	} | null = null;
	if (after) {
		cursorRow =
			(await db
				.select({
					slug: schema.termSummary.slug,
					totalScore: schema.termSummary.totalScore,
					lastActivityAt: schema.termSummary.lastActivityAt,
				})
				.from(schema.termSummary)
				.where(eq(schema.termSummary.slug, after))
				.get()) ?? null;
	}

	// Keyset: sort column DESC, slug ASC (stable tie-breaker).
	// `last_activity_at` is a Date; drizzle compares it as the underlying
	// integer timestamp. A null `last_activity_at` (term seeded but never
	// touched) sorts last under DESC — the cursor predicate skips those when
	// the cursor row itself has a non-null timestamp.
	const cursorPredicate = cursorRow
		? sort === "popular"
			? or(
					lt(schema.termSummary.totalScore, cursorRow.totalScore),
					and(
						eq(schema.termSummary.totalScore, cursorRow.totalScore),
						gt(schema.termSummary.slug, cursorRow.slug),
					),
				)
			: cursorRow.lastActivityAt
				? or(
						lt(schema.termSummary.lastActivityAt, cursorRow.lastActivityAt),
						and(
							eq(schema.termSummary.lastActivityAt, cursorRow.lastActivityAt),
							gt(schema.termSummary.slug, cursorRow.slug),
						),
					)
				: gt(schema.termSummary.slug, cursorRow.slug)
		: undefined;

	const orderBy =
		sort === "popular"
			? [desc(schema.termSummary.totalScore), schema.termSummary.slug]
			: [desc(schema.termSummary.lastActivityAt), schema.termSummary.slug];

	const fetched = await db
		.select({
			slug: schema.termSummary.slug,
			title: schema.termSummary.title,
			firstLetter: schema.termSummary.firstLetter,
			definitionCount: schema.termSummary.definitionCount,
			totalScore: schema.termSummary.totalScore,
			excerpt: schema.termSummary.excerpt,
			firstAt: schema.termSummary.firstAt,
			lastActivityAt: schema.termSummary.lastActivityAt,
			lastEditAt: schema.termSummary.lastEditAt,
		})
		.from(schema.termSummary)
		.where(cursorPredicate)
		.orderBy(...orderBy)
		.limit(first + 1);

	const hasNextPage = fetched.length > first;
	const sliced = hasNextPage ? fetched.slice(0, first) : fetched;

	const rows: TermSummaryRow[] = sliced.map((r) => ({
		id: r.slug,
		slug: r.slug,
		title: r.title,
		count: r.definitionCount,
		totalScore: r.totalScore,
		excerpt: r.excerpt ?? null,
		firstAt: r.firstAt,
		lastEdit: r.lastEditAt,
		firstLetter: r.firstLetter,
		definitionCount: r.definitionCount,
		lastActivityAt: r.lastActivityAt,
	}));

	const totalCountRow = await db
		.select({n: sql<number>`count(*)`})
		.from(schema.termSummary)
		.get();
	const totalCount = totalCountRow?.n ?? 0;

	const last = rows.at(-1) ?? null;
	return {
		rows,
		hasNextPage,
		endCursor: last ? last.slug : null,
		totalCount,
	};
}
