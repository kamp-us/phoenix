/**
 * The saved-posts reconcile rule, factored DOM-free so the row drop decision AND the
 * list count + empty-state share ONE predicate (#1417: the count/empty-state had
 * drifted onto edge-`node` truthiness while `SavedRow` read live `isSaved`). An in-list
 * un-save publishes `live.update("Post", …, {changed:["isSaved"]})` with no `deleteEdge`,
 * so the edge/node stay truthy after the row drops — node presence is therefore NOT a
 * saved-ness signal; live `isSaved` is.
 */

/**
 * A row counts as saved iff its live `isSaved` is not explicitly `false`. `null`/
 * `undefined` (not-yet-resolved) read as saved, matching `SavedRow`, which only drops
 * on `=== false`.
 */
export function isRowSaved(isSaved: boolean | null | undefined): boolean {
	return isSaved !== false;
}

/**
 * How many of `ids` are still saved, given each row's reported live `isSaved`. An id
 * absent from `savedById` (a row that hasn't reported yet) defaults to saved via
 * `isRowSaved(undefined)`, so the count never under-reports before rows resolve, and a
 * stale report for an id no longer in the connection is ignored.
 */
export function countSavedRows(
	ids: ReadonlyArray<string | number>,
	savedById: ReadonlyMap<string | number, boolean | null | undefined>,
): number {
	return ids.reduce<number>((n, id) => (isRowSaved(savedById.get(id)) ? n + 1 : n), 0);
}
