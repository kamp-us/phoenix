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
import {desc} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../view/drizzle/schema";

export type ListSort = "recent" | "popular";

/**
 * Mirrors the GraphQL `Term` type's resolver expectations. `firstAt` /
 * `lastEdit` are pre-converted to JS Date in the resolver if present.
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
	}));
}
