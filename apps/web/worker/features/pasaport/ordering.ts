/**
 * Pasaport `Profile.contributions` ordering — the single source the view
 * `orderBy` and the service keyset both derive from (ADR 0019; see
 * `db/ordering.ts`). The contributions feed merges three tables
 * (definition/post/comment) under one global `createdAt desc, id desc` order, so
 * the ordering is parameterized over the table whose columns it names. The
 * view's nominal `orderBy` derives from the same declaration (`viewOrderBy`
 * reads only the field name + direction, never the Drizzle column).
 */

import type {DataViewOrderBy} from "@nkzw/fate/server";
import * as schema from "../../db/drizzle/schema.ts";
import {type Ordering, viewOrderBy} from "../../db/ordering.ts";

/** A table the contributions feed merges over — each keyset by its own columns. */
export type ContributionTable =
	| typeof schema.definitionRecord
	| typeof schema.postRecord
	| typeof schema.commentRecord;

/** The contributions ordering for one merged table: `createdAt desc, id desc`. */
export function contributionOrdering(table: ContributionTable): Ordering {
	return [
		{field: "createdAt", column: table.createdAt, dir: "desc"},
		{field: "id", column: table.id, dir: "desc"},
	];
}

/**
 * The nominal `Profile.contributions` view `orderBy`, derived from the same
 * ordering the keyset uses (`viewOrderBy` reads only field name + direction, so
 * any merged table yields the identical `[{createdAt: "desc"}, {id: "desc"}]`).
 */
export const CONTRIBUTION_VIEW_ORDER_BY: DataViewOrderBy = viewOrderBy(
	contributionOrdering(schema.definitionRecord),
);
