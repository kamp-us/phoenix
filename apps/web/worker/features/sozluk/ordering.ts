/**
 * Sözlük connection orderings — the single source each connection's fate-view
 * `orderBy` and service Drizzle keyset both derive from (ADR 0019; see
 * `db/ordering.ts`). The view-field name and the Drizzle column for each sort
 * column are named together here, so a sort change is a one-site edit and the
 * view/keyset can't drift.
 */

import * as schema from "../../db/drizzle/schema.ts";
import type {Ordering} from "../../db/ordering.ts";

/**
 * `Term.definitions` (the term-page definition list): `score desc, createdAt
 * asc, id asc`. Consumed by `Term.definitions`' view `orderBy` and the
 * `Sozluk.listDefinitionsKeyset` keyset.
 */
export const DEFINITION_ORDERING: Ordering = [
	{field: "score", column: schema.definitionRecord.score, dir: "desc"},
	{field: "createdAt", column: schema.definitionRecord.createdAt, dir: "asc"},
	{field: "id", column: schema.definitionRecord.id, dir: "asc"},
];

/** The term-summary list sorts (`Sozluk.listTermSummariesConnection`). */
export type TermSummarySort = "recent" | "popular";

/**
 * The term-summary connection orderings by sort — a lead column (descending)
 * plus the `slug` asc tiebreaker. The view roots (`recentTerms`/`popularTerms`)
 * are custom-resolver lists whose `orderBy` is nominal (the resolver owns the
 * order), so this single-sources the keyset's lead-tuple against its own
 * `.orderBy(…)`, not a view `orderBy`.
 */
export const TERM_SUMMARY_ORDERING: Record<TermSummarySort, Ordering> = {
	popular: [
		{field: "totalScore", column: schema.termRecord.totalScore, dir: "desc"},
		{field: "slug", column: schema.termRecord.slug, dir: "asc"},
	],
	recent: [
		{field: "lastActivityAt", column: schema.termRecord.lastActivityAt, dir: "desc"},
		{field: "slug", column: schema.termRecord.slug, dir: "asc"},
	],
};
