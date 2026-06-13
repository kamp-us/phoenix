/**
 * The `term_summary` column projection and the `TermSummaryRow` mapper, shared
 * by every term-summary read so they can't drift on column selection or mapping.
 */
import * as schema from "../../db/drizzle/schema.ts";

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

// Pass to `db.select(...)`; pairs with `toTermSummaryRow`.
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
