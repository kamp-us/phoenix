/**
 * `Term`'s one column→field map — the single structure the row mapper
 * (`toTermSummaryRow`), the wire shaper (`toTerm` in `shapers.ts`), and the view
 * field declaration (`TermView` in `views.ts`) all derive from, so a one-field
 * change touches this map instead of three hand-synced restatements (#1544, the
 * sözlük slice of the fate-wire collapse #1332; the `Term` mirror of
 * `definition-fields.ts`).
 *
 * The map absorbs `Term`'s per-source naming divergence: the `term_record`
 * projection names the count `definitionCount` and the last-edit `lastEditAt`,
 * while the wire carries `count` (mirrored by `definitionCount`), `lastEdit`, and
 * an `id` that IS the slug (a term's client normalization key). Each intrinsic
 * field carries a reader that maps a `TermSummarySelection` row onto its wire
 * value, so the divergence lives in the map, not at every call site.
 */
import * as schema from "../../db/drizzle/schema.ts";

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

/**
 * The intrinsic (record-derived) wire fields, in `TermView` order, each mapping a
 * `TermSummarySelection` row onto its wire value. The keys ARE the wire field
 * names; the readers absorb the `definitionCount`→`count`, `lastEditAt`→`lastEdit`,
 * and slug-as-`id` divergence.
 */
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

/** The record-derived row: every reader's return type under its wire field name. */
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
 * The view/wire field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` reads the literal field map off this, so it can't be a
 * dynamically-built object). `satisfies Record<keyof TermSummaryRow, true>` pins
 * it to exactly the row's fields: dropping a field here (or adding one to the row
 * type without listing it) is a compile error, so the view stays in lockstep with
 * the row mapper. `definitions` is the list relation, declared structurally in
 * `views.ts` (no record column to collapse from).
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

/**
 * Map a `term_record` projection row onto its `TermSummaryRow` fields by running
 * every reader in the column→field map — the single place the record→row mapping
 * lives.
 */
export const toTermSummaryRow = (r: TermSummarySelection): TermSummaryRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](r),
		]),
	) as TermSummaryRow;
