/**
 * `Term`'s one column→field map — the row mapper, the wire shaper, and the view field
 * declaration all derive from it, so a one-field change lands in one place. It also
 * absorbs the record/wire naming divergence (`definitionCount`→`count`,
 * `lastEditAt`→`lastEdit`, and an `id` that IS the slug).
 */
import * as schema from "../../db/drizzle/schema.ts";

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

/** The keys ARE the wire field names, in `TermView` order. */
const intrinsicFields = {
	id: (r) => r.slug,
	slug: (r) => r.slug,
	title: (r) => r.title,
	count: (r) => r.definitionCount,
	totalScore: (r) => r.totalScore,
	excerpt: (r) => r.excerpt ?? null,
	firstAt: (r) => r.firstAt,
	lastEdit: (r) => r.lastEditAt,
	firstLetter: (r) => r.firstLetter,
	definitionCount: (r) => r.definitionCount,
	lastActivityAt: (r) => r.lastActivityAt,
} satisfies Record<string, (r: TermSummarySelection) => unknown>;

export type TermSummaryRow = {
	[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>;
};

export interface TermConnectionPage {
	rows: TermSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Must stay a static literal — fate's `FateDataView` reads the field map off it, so it
 * cannot be built dynamically. The `satisfies` pins it to exactly the row's fields, so a
 * missing or extra field is a compile error rather than a silent wire drift.
 */
export const termViewFields = {
	id: true,
	slug: true,
	title: true,
	count: true,
	totalScore: true,
	excerpt: true,
	firstAt: true,
	lastEdit: true,
	firstLetter: true,
	definitionCount: true,
	lastActivityAt: true,
} as const satisfies Record<keyof TermSummaryRow, true>;

export const toTermSummaryRow = (r: TermSummarySelection): TermSummaryRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](r),
		]),
	) as TermSummaryRow;
