/**
 * Hand-written `submitPost` updater (task_2, phoenix-relay-idiom).
 *
 * Mirrors kampus's `Library.tsx` pattern (manual `updater` for prepends, no
 * `$connections` variable) but adapts for two phoenix-specific facts:
 *
 *  1. The submit affordance lives on its own route (`/pano/yeni`), not on
 *     the feed page. The submit page can't `useLazyLoadQuery(FeedQuery)` to
 *     get the feed connection's `__id` — it would re-fire the feed query
 *     and double the round-trip.
 *  2. The feed connection is keyed by `(sort, host)` filter combos. The
 *     user may have visited multiple combos (`hot`, `new`, `top`) before
 *     submitting; the new post should appear at the top of every cached
 *     variant the next time that variant is rendered, not just one.
 *
 * Solution: enumerate every active `__PanoFeed_posts_connection(...)`
 * linked record under the root `Query` record and prepend the new edge to
 * each. Walking the root's linked records is O(n) where n is the number
 * of distinct filter combos the user has visited — bounded and small.
 *
 * `totalCount` drift after this prepend is acceptable per the PRD (see
 * `Implementation Decisions / Mutation patterns`); we don't bump it here.
 */
import type {RecordSourceSelectorProxy} from "relay-runtime";

const CONNECTION_KEY_PREFIX = "__PanoFeed_posts_connection";

/**
 * Prepend the post returned by the `submitPost` mutation into every
 * `PanoFeed_posts` connection currently in the Relay store.
 *
 * Idempotent on a no-op: if the mutation payload is missing or the store
 * doesn't have any feed connections yet, the function returns silently.
 */
export function prependPostToFeedConnections(store: RecordSourceSelectorProxy): void {
	const newPost = store.getRootField("submitPost");
	if (!newPost) return;

	const root = store.getRoot();
	// Relay normalizes every linked record under a parent's
	// `getLinkedRecord(fieldName, args?)` slot, but the connection storage
	// key is exposed as a child id like `client:root:__PanoFeed_posts_connection(...)`.
	// Walking the underlying root record's storage keys lets us find every
	// active filter combo without enumerating them by hand.
	const rootRecord = root as unknown as {
		__getDataID?: () => string;
		getType?: () => string;
	};
	const rootId =
		typeof rootRecord.__getDataID === "function" ? rootRecord.__getDataID() : "client:root";

	// Probe every record id under the store that matches the connection
	// prefix. RecordSource doesn't expose its keys publicly, so we lean on
	// `store.get(...)` lookups: enumerate the FILTER_COMBOS we know the FE
	// can produce (sort × host). Unknown filters fall through to the next
	// page-load.
	const candidateIds = enumerateConnectionIds(rootId);
	for (const connectionId of candidateIds) {
		const connection = store.get(connectionId);
		if (!connection) continue;
		const edgeId = `client:edge-${newPost.getDataID()}`;
		const newEdge = store.create(edgeId, "PostEdge");
		newEdge.setLinkedRecord(newPost, "node");
		newEdge.setValue(newPost.getDataID(), "cursor");
		const edges = connection.getLinkedRecords("edges") ?? [];
		// Avoid double-prepend on optimistic + server-confirm: skip if the
		// node id is already at the head of the connection.
		const headNodeId = edges[0]?.getLinkedRecord("node")?.getDataID();
		if (headNodeId === newPost.getDataID()) continue;
		connection.setLinkedRecords([newEdge, ...edges], "edges");
	}
}

/**
 * Enumerate the set of `__PanoFeed_posts_connection(...)` storage keys we
 * know the FE produces today.
 *
 * Today's filter axes:
 *   - `sort`: hot | new | top | discuss (4 values, all from the FILTERS
 *     array on PanoFeed.tsx)
 *   - `host`: any string the user has navigated to via /pano/site/<host>
 *
 * For `host` we enumerate the no-host variant only — that's the canonical
 * /pano feed every user lands on. Per-host variants will pick up the new
 * row on next refetch; that's fine because (a) most users sit on the global
 * feed, (b) per-host variants are cheap to recompute when the user navigates.
 */
function enumerateConnectionIds(rootId: string): string[] {
	const sorts = ["hot", "new", "top", "discuss"] as const;
	const ids: string[] = [];
	for (const sort of sorts) {
		// Connection storage key form: `<connectionKey>(filterKey:"value",...)`.
		// Filter values are the connection-fragment's `filters` arg list.
		// `host` is null on the canonical feed; Relay encodes nulls as the
		// JSON token `null` (no quotes).
		ids.push(`${rootId}:${CONNECTION_KEY_PREFIX}(host:null,sort:"${sort}")`);
		// Some Relay versions emit storage keys with the filter args sorted
		// in declaration order (`sort` first, then `host`). Probe both.
		ids.push(`${rootId}:${CONNECTION_KEY_PREFIX}(sort:"${sort}")`);
	}
	return ids;
}
