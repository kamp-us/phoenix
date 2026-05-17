/**
 * Hand-written `addComment` updater (optimistic-only).
 *
 * Mirrors `panoFeedUpdater.prependPostToFeedConnections` but for
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
 * `totalCount` is bumped because it drives the "N yorum" thread heading —
 * leaving it stale shows the wrong count after the first add (tested via
 * `17-pano-add-comment.spec.ts:51`).
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
	// Bump `totalCount` on the connection record. The connection-local
	// `totalCount` drives the "N yorum" thread heading directly — leaving it
	// stale shows the wrong count after the first add. Tested via
	// `17-pano-add-comment.spec.ts:51`.
	const currentTotal = (connection.getValue("totalCount") as number | undefined) ?? 0;
	connection.setValue(currentTotal + 1, "totalCount");
}
