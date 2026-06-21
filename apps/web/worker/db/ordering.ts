/**
 * Per-connection ordering as ONE declaration (ADR 0019). A connection's sort is
 * a nominal fate-view `orderBy` (drives cursor round-tripping) AND a Drizzle
 * keyset (`.orderBy(…)` + the `keysetAfter` lead-column tuple); the two used to
 * be copied per connection and kept in lockstep only by a docblock, where a
 * missed edit skips/dupes cursor rows silently. An `Ordering` names each column
 * once — its view-field name, its Drizzle column, and its direction — so the
 * view `orderBy` and the service keyset both DERIVE from it and can no longer
 * disagree. Mirrors `src/lib/panoFeedSort.ts`, which single-sources pano's
 * (per-sort) feed ordering the same way.
 */

import type {DataViewOrderBy} from "@nkzw/fate/server";
import {asc, desc, type SQL, type SQLWrapper} from "drizzle-orm";
import type {KeysetDir, KeysetKey} from "./keyset.ts";

/**
 * One ordering column. `field` is the fate-view field name (what the view
 * `orderBy` keys on); `column` is the Drizzle column the service orders by and
 * keysets on; `dir` is shared by both. Pairing the two names in one place is the
 * whole point — the view field and the DB column can no longer drift apart.
 */
export interface OrderingColumn {
	readonly field: string;
	readonly column: SQLWrapper;
	readonly dir: KeysetDir;
}

/** A connection's ordering tuple — the columns in lexicographic precedence. */
export type Ordering = ReadonlyArray<OrderingColumn>;

/** The fate-view `orderBy` for this ordering — `[{field: dir}, …]` (nominal). */
export function viewOrderBy(ordering: Ordering): DataViewOrderBy {
	return ordering.map((c) => ({[c.field]: c.dir}));
}

/** The Drizzle `.orderBy(…)` columns for this ordering — `desc(col)` / `asc(col)`. */
export function orderByColumns(ordering: Ordering): SQL[] {
	return ordering.map((c) => (c.dir === "desc" ? desc(c.column) : asc(c.column)));
}

/**
 * The `keysetAfter` lead-column tuple for this ordering, given a `cursorValue`
 * that reads each column's cursor value off the resolved cursor row (by
 * `field`). Column, direction, and precedence come from the SAME `Ordering` the
 * view `orderBy` and `.orderBy(…)` use, so the keyset predicate can't disagree
 * with the sort it pages.
 */
export function keysetKeys(
	ordering: Ordering,
	cursorValue: (field: string) => unknown,
): KeysetKey[] {
	return ordering.map((c) => ({column: c.column, dir: c.dir, value: cursorValue(c.field)}));
}
