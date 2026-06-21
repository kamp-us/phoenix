/**
 * The `term_record` column projection and the `TermSummaryRow` mapper, shared
 * by every term read so they can't drift on column selection or mapping.
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
	slug: schema.termRecord.slug,
	title: schema.termRecord.title,
	firstLetter: schema.termRecord.firstLetter,
	definitionCount: schema.termRecord.definitionCount,
	totalScore: schema.termRecord.totalScore,
	excerpt: schema.termRecord.excerpt,
	firstAt: schema.termRecord.firstAt,
	lastActivityAt: schema.termRecord.lastActivityAt,
	lastEditAt: schema.termRecord.lastEditAt,
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
