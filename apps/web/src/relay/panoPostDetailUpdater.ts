/**
 * Hand-written `addComment` updater (task_3, phoenix-relay-idiom).
 *
 * Mirrors `panoFeedUpdater.prependPostToFeedConnections` from task_2 but for
 * the post-detail comment thread. The comment connection is keyed by the
 * post DataID — the page knows it via the `post.__id` reference Relay
 * auto-emits when a `@connection`-bearing fragment is spread into the
 * `Post` selection.
 *
 * Comments are displayed chronological-asc on link-aggregator UIs (oldest
 * first); a fresh reply lands at the END of the connection. The page's
 * tree-builder picks up the new edge on the next render and slots it under
 * its parent via the `parentId` field.
 *
 * Idempotent on the optimistic→server transition: if the connection's tail
 * edge already references the new comment id (e.g. the optimistic pass
 * landed first), the appender skips. Relay rolls back the optimistic
 * update first and re-applies the server updater, so the connection ends
 * up with the real Comment.id at the tail with no double-append.
 *
 * `totalCount` drift after this append is acceptable per the PRD (see
 * `Implementation Decisions / Mutation patterns`); we don't bump it here.
 */
import {ConnectionHandler, type RecordSourceSelectorProxy} from "relay-runtime";

const COMMENT_CONNECTION_KEY = "PanoPostDetail_comments";

/**
 * Append the comment returned by the `addComment` mutation into the
 * `PanoPostDetail_comments` connection on the given post.
 *
 * `postRecordId` is the Relay DataID of the parent `Post` record — the
 * page reads this via `usePaginationFragment(...)`'s `data.__id` (or
 * `data.id` if the fragment selects it; the latter is the global id
 * which Relay normalizes to as the DataID).
 */
export function appendCommentToPostConnection(
	store: RecordSourceSelectorProxy,
	postRecordId: string,
): void {
	const newComment = store.getRootField("addComment");
	if (!newComment) return;

	const post = store.get(postRecordId);
	if (!post) return;

	const connection = ConnectionHandler.getConnection(post, COMMENT_CONNECTION_KEY);
	if (!connection) return;

	// Idempotency: if the tail edge already points at the new comment id
	// (optimistic + server-confirm), skip. ConnectionHandler.insertEdgeAfter
	// would otherwise duplicate.
	const edges = connection.getLinkedRecords("edges") ?? [];
	const tailNodeId = edges[edges.length - 1]?.getLinkedRecord("node")?.getDataID();
	if (tailNodeId === newComment.getDataID()) return;

	const newEdge = ConnectionHandler.createEdge(store, connection, newComment, "CommentEdge");
	newEdge.setValue(newComment.getDataID(), "cursor");
	ConnectionHandler.insertEdgeAfter(connection, newEdge);
}

/**
 * Insert a `Comment` record into the `PanoPostDetail_comments` connection
 * over the live-update path (task_3, phoenix-relay-idiom). Used by the
 * `useLiveAgentV2` `applyToStore` callback when a peer client posts a new
 * comment that arrives over the WebSocket subscription.
 *
 * Differs from {@link appendCommentToPostConnection} in two ways:
 *  1. The new record isn't a mutation root field — caller passes in the
 *     {@link RecordProxy} they constructed via `store.create(...)`.
 *  2. Idempotency check is by id: peer-broadcasted state may include
 *     comments the local mutation updater already inserted (own-write
 *     echo). Skip if any edge in the connection already references the id.
 *
 * The signature accepts a `record` proxy rather than a {@link CommentRow}
 * shape so the caller can pre-populate scalar fields with whatever it
 * received in the WS payload before splicing it in.
 */
export function insertLiveCommentEdge(
	store: RecordSourceSelectorProxy,
	postRecordId: string,
	commentRecordId: string,
): void {
	const post = store.get(postRecordId);
	if (!post) return;
	const connection = ConnectionHandler.getConnection(post, COMMENT_CONNECTION_KEY);
	if (!connection) return;
	const edges = connection.getLinkedRecords("edges") ?? [];
	for (const e of edges) {
		const nodeId = e.getLinkedRecord("node")?.getDataID();
		if (nodeId === commentRecordId) return;
	}
	const commentRecord = store.get(commentRecordId);
	if (!commentRecord) return;
	const newEdge = ConnectionHandler.createEdge(store, connection, commentRecord, "CommentEdge");
	newEdge.setValue(commentRecordId, "cursor");
	ConnectionHandler.insertEdgeAfter(connection, newEdge);
}
