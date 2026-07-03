/**
 * Optimistic `definition.delete` — the D1 edge-drop for the *nested*
 * `Term.definitions` connection (ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md),
 * #1681, epic #1637). `definition.delete` is a **`Term`**-returning mutation (it
 * re-resolves the parent for fresh counts), so fate's `delete: true` is the wrong
 * entity — the server instead publishes `live.definition.term(slug).deleteEdge`.
 * And `Term.definitions` is a nested connection carried on the `term` query, never a
 * registered root list, so fate's declarative `delete` membership can't reach it
 * (`registerRootList` is gated on `!filterConnectionArgs`). The edge is instead
 * dropped by this phoenix client helper, which drives the same list state
 * `removeEntityFromListState` mutates from the SSE `deleteEdge`.
 *
 * `definition.delete` has **no reply tree**, so ADR 0125's reply-aware D1 branch
 * collapses to a plain edge-drop — no `[silindi]` tombstone, no conservative-on-
 * uncertain fallback (the `comment.delete` sibling owns those). The definition id is
 * already the **canonical server id** (not a temp id), so reconciliation is trivial:
 * the server `deleteEdge` frame removes an id already absent from the list — a no-op,
 * no reappear, zero divergence. The caller rolls back — restoring the edge — on a
 * rejected delete.
 *
 * See `.patterns/fate-mutations-client.md` (§Optimistic nested-connection membership)
 * and the add-side sibling {@link appendOptimisticDefinitionEdge}.
 */
import type {List} from "@nkzw/fate";
import type {DefinitionListStore} from "./definitionAddOptimistic";

/**
 * Drop `definitionEntityId` (a `Definition` **entity id**, e.g. `Definition:<id>`)
 * from every list state backing the term's nested `definitions` connection, and
 * return a rollback that restores each list to its pre-drop snapshot.
 *
 * Removes the id and its aligned cursor (keeping `ids`/`cursors` index-aligned) from
 * each backing list — the same slot the server `deleteEdge` targets. A list that
 * doesn't carry the id is left untouched. On the mutation HTTP result a server
 * `deleteEdge(id)` then removes an id already gone — a no-op by canonical id, so
 * optimistic drop and server frame collapse to one absent edge (no reappear). The
 * caller invokes the returned rollback on a rejected delete to restore the edge.
 *
 * A no-op (empty rollback) when the term has no loaded `definitions` list, or none
 * that carries the id — nothing to drop.
 */
export function dropOptimisticDefinitionEdge(
	store: DefinitionListStore,
	termEntityId: string,
	definitionEntityId: string,
): () => void {
	const snapshots = store.getListsForField(termEntityId, "definitions");
	for (const [key, list] of snapshots) {
		const idx = list.ids.indexOf(definitionEntityId);
		if (idx === -1) continue;
		const ids = list.ids.filter((_, i) => i !== idx);
		const next: List = list.cursors
			? {...list, ids, cursors: list.cursors.filter((_, i) => i !== idx)}
			: {...list, ids};
		store.setList(key, next);
	}
	return () => {
		for (const [key, list] of snapshots) store.restoreList(key, list);
	};
}
