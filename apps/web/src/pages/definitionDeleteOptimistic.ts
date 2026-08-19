/**
 * Optimistic `definition.delete` for the *nested* `Term.definitions` connection. fate's
 * declarative `delete` membership is wrong twice over here: the mutation returns a **`Term`**
 * (it re-resolves the parent for fresh counts), and a nested connection is never a registered
 * root list. So the edge is dropped here instead, and the server's `deleteEdge` frame then
 * removes an id already gone — a no-op by canonical id, no reappear. See ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md)
 * and `.patterns/fate-mutations-client.md` (§Optimistic nested-connection membership).
 */
import type {List} from "@nkzw/fate";
import type {DefinitionListStore} from "./definitionAddOptimistic";

/** Drops the id and its aligned cursor together — `ids` and `cursors` must stay index-aligned. */
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
