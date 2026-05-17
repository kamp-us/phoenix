/**
 * Hand-written `addDefinition` updater (optimistic-only).
 *
 * Mirrors `panoPostDetailUpdater.appendCommentToPostConnection` but inverts
 * the insertion order: definitions render score-DESC on the term page, and
 * a fresh definition lands at score `0` — but the convention from the PRD
 * is to **prepend** so the user immediately sees their new entry at the top
 * (task description: "definitions are score-desc, so this updater prepends
 * like submitPost — not appends like addComment"). The next refetch
 * reconciles the rank against the canonical server order.
 *
 * Idempotent on the optimistic→server transition: if the connection's head
 * edge already references the new definition id (e.g. the optimistic pass
 * landed first), the prepender skips. Relay rolls back the optimistic
 * update first and re-applies the server updater, so the connection ends
 * up with the real Definition.id at the head with no double-prepend.
 *
 * `totalCount` drift after this prepend is acceptable per the PRD (see
 * `Implementation Decisions / Mutation patterns`); we don't bump it here.
 */
import {ConnectionHandler, type RecordSourceSelectorProxy} from "relay-runtime";

const DEFINITION_CONNECTION_KEY = "SozlukTermPage_definitions";

/**
 * Prepend the definition returned by the `addDefinition` mutation into the
 * `SozlukTermPage_definitions` connection on the given term.
 *
 * `termRecordId` is the Relay DataID of the parent `Term` record — the
 * page reads this via `useFragment(...)`'s `data.id` (the global id, which
 * Relay normalizes to as the DataID).
 */
export function prependDefinitionToTermConnection(
	store: RecordSourceSelectorProxy,
	termRecordId: string,
): void {
	const newDefinition = store.getRootField("addDefinition");
	if (!newDefinition) return;

	const term = store.get(termRecordId);
	if (!term) return;

	const connection = ConnectionHandler.getConnection(term, DEFINITION_CONNECTION_KEY);
	if (!connection) return;

	// Idempotency: if the head edge already points at the new definition id
	// (optimistic + server-confirm), skip. Without this guard,
	// ConnectionHandler.insertEdgeBefore would duplicate.
	const edges = connection.getLinkedRecords("edges") ?? [];
	const headNodeId = edges[0]?.getLinkedRecord("node")?.getDataID();
	if (headNodeId === newDefinition.getDataID()) return;

	const newEdge = ConnectionHandler.createEdge(
		store,
		connection,
		newDefinition,
		"DefinitionEdge",
	);
	newEdge.setValue(newDefinition.getDataID(), "cursor");
	ConnectionHandler.insertEdgeBefore(connection, newEdge);
}
