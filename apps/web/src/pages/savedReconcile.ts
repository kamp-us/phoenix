/**
 * The one saved-ness rule, shared by the row drop and the list count + empty-state. An
 * in-list un-save publishes a live `isSaved` update with no `deleteEdge`, so the edge and
 * node stay truthy — node presence is NOT a saved-ness signal, live `isSaved` is (#1417).
 */

// Unresolved (`null`/`undefined`) reads as saved: `SavedRow` only drops on `=== false`.
export function isRowSaved(isSaved: boolean | null | undefined): boolean {
	return isSaved !== false;
}

// A row that hasn't reported yet defaults to saved, so the count never under-reports
// while rows resolve; a report for an id no longer in `ids` is ignored.
export function countSavedRows(
	ids: ReadonlyArray<string | number>,
	savedById: ReadonlyMap<string | number, boolean | null | undefined>,
): number {
	return ids.reduce<number>((n, id) => (isRowSaved(savedById.get(id)) ? n + 1 : n), 0);
}
