/**
 * The one ordering the `Profile.contributions` view `orderBy` and the service keyset both
 * derive from (ADR 0019). It is parameterized over the table because the feed merges
 * three of them under one global order.
 */

import type {DataViewOrderBy} from "@nkzw/fate/server";
import * as schema from "../../db/drizzle/schema.ts";
import {type Ordering, viewOrderBy} from "../../db/ordering.ts";

export type ContributionTable =
	| typeof schema.definitionRecord
	| typeof schema.postRecord
	| typeof schema.commentRecord;

export function contributionOrdering(table: ContributionTable): Ordering {
	return [
		{field: "createdAt", column: table.createdAt, dir: "desc"},
		{field: "id", column: table.id, dir: "desc"},
	];
}

/**
 * `viewOrderBy` reads only field name + direction, so passing any one of the merged
 * tables yields the identical view ordering.
 */
export const CONTRIBUTION_VIEW_ORDER_BY: DataViewOrderBy = viewOrderBy(
	contributionOrdering(schema.definitionRecord),
);
