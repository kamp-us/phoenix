/**
 * Sözlük connection orderings — the single source each connection's fate-view `orderBy` and
 * service Drizzle keyset both derive from (ADR 0019), so a sort change is a one-site edit.
 */

import * as schema from "../../db/drizzle/schema.ts";
import type {Ordering} from "../../db/ordering.ts";

export const DEFINITION_ORDERING: Ordering = [
	{field: "score", column: schema.definitionRecord.score, dir: "desc"},
	{field: "createdAt", column: schema.definitionRecord.createdAt, dir: "asc"},
	{field: "id", column: schema.definitionRecord.id, dir: "asc"},
];

export type TermSummarySort = "recent" | "popular";

// A lead column (descending) plus the `slug` asc tiebreaker. The view roots are
// custom-resolver lists whose `orderBy` is nominal, so this single-sources the keyset's
// lead-tuple against its own `.orderBy(…)`, not a view `orderBy`.
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
