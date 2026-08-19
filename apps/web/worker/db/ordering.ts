/**
 * Per-connection ordering as ONE declaration (ADR 0019). A connection's sort is both a
 * fate-view `orderBy` and a Drizzle keyset; copied separately they drift, and a missed
 * edit skips or dupes cursor rows silently. An `Ordering` names each column once so both
 * DERIVE from it.
 */

import type {DataViewOrderBy} from "@nkzw/fate/server";
import {asc, desc, type SQL, type SQLWrapper} from "drizzle-orm";
import type {KeysetDir, KeysetKey} from "./keyset.ts";

/**
 * `field` is the fate-view field name; `column` is the Drizzle column the service orders
 * by and keysets on; `dir` is shared by both.
 */
export interface OrderingColumn {
	readonly field: string;
	readonly column: SQLWrapper;
	readonly dir: KeysetDir;
}

/** The columns in lexicographic precedence. */
export type Ordering = ReadonlyArray<OrderingColumn>;

export function viewOrderBy(ordering: Ordering): DataViewOrderBy {
	return ordering.map((c) => ({[c.field]: c.dir}));
}

export function orderByColumns(ordering: Ordering): SQL[] {
	return ordering.map((c) => (c.dir === "desc" ? desc(c.column) : asc(c.column)));
}

/** `cursorValue` reads each column's cursor value off the resolved cursor row, by `field`. */
export function keysetKeys(
	ordering: Ordering,
	cursorValue: (field: string) => unknown,
): KeysetKey[] {
	return ordering.map((c) => ({column: c.column, dir: c.dir, value: cursorValue(c.field)}));
}
