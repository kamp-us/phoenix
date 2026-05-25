/**
 * `term_summary` row mapping — the single source for the column projection and
 * the `TermSummaryRow` shaping shared by every read that returns a term summary
 * (`Sozluk.getTermSummariesByIds`, `listTermSummaries`, `listTermSummariesConnection`).
 *
 * Kept out of `Sozluk.ts` so the projection + mapper live in exactly one place
 * and the three methods can't drift on column selection or field mapping.
 */
import * as schema from "../../db/drizzle/schema";

/** The list/keyset term-summary row — the shape every term-summary read returns. */
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

export interface TermConnectionPage {
	rows: TermSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Canonical `term_summary` column selection — pass to `db.select(...)`. Pairs
 * with `toTermSummaryRow`, which shapes a selected row onto the wire-facing
 * `TermSummaryRow`.
 */
export const termSummaryColumns = {
	slug: schema.termSummary.slug,
	title: schema.termSummary.title,
	firstLetter: schema.termSummary.firstLetter,
	definitionCount: schema.termSummary.definitionCount,
	totalScore: schema.termSummary.totalScore,
	excerpt: schema.termSummary.excerpt,
	firstAt: schema.termSummary.firstAt,
	lastActivityAt: schema.termSummary.lastActivityAt,
	lastEditAt: schema.termSummary.lastEditAt,
} as const;

/** A row selected via `termSummaryColumns`. */
export interface TermSummarySelection {
	slug: string;
	title: string;
	firstLetter: string;
	definitionCount: number;
	totalScore: number;
	excerpt: string | null;
	firstAt: Date | null;
	lastActivityAt: Date | null;
	lastEditAt: Date | null;
}

/** Shape a selected `term_summary` row (`termSummaryColumns`) onto a `TermSummaryRow`. */
export const toTermSummaryRow = (r: TermSummarySelection): TermSummaryRow => ({
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
});
