/**
 * Pins one live subscription open for a component's whole mount lifetime, so the
 * shared native SSE connection's refcount never reaches 0 while the view is on
 * screen.
 *
 * Why this exists: fate's native live client is refcounted — `remove()` does
 * `if (operations.size === 0) { source.close(); nativeLiveClient = undefined }`,
 * and the next subscribe rebuilds a fresh `EventSource` with a new random
 * `connectionId`. `useLiveListView`'s subscribe effect re-keys on the connection's
 * `metadata.key`, which goes transiently null (the connection comes back as a
 * plain array, no `ConnectionTag`) during the in-flight refetch a write mutation
 * triggers. During that window the only live subscription on the page
 * unsubscribes → refcount hits 0 → the stream closes → the mutation's
 * fire-and-forget `appendNode` publish targets the dead connectionId and is
 * dropped (best-effort v1 live, no replay). The live event is LOST, not late, so
 * the just-created row never appears until a manual refresh.
 *
 * The pin holds a *second*, stable subscription keyed on an identity that does NOT
 * change across that churn (the parent entity ref's id, or a latched connection
 * `listKey`). With one always-present operation, `operations.size` never reaches 0
 * during the churning view's cleanup→re-subscribe, the EventSource + connectionId
 * stay stable, and the publish reaches a live connection. It releases on unmount,
 * so the stream tears down cleanly when the page leaves (no leak).
 *
 * The durable transport fix (don't tear down on a transient 0-refcount) lives
 * upstream and is tracked separately (#711); this is the in-repo mitigation.
 * See `.patterns/fate-live-views.md`.
 */
import {type ConnectionMetadata, ConnectionTag, isViewTag, type View} from "@nkzw/fate";
import {useEffect, useMemo, useRef} from "react";
import {useFateClient, type ViewRef} from "react-fate";

export const connectionMetadataOf = (connection: unknown): ConnectionMetadata | null => {
	if (connection == null || typeof connection !== "object") return null;
	const metadata = (connection as Record<symbol, unknown>)[ConnectionTag];
	return metadata != null && typeof metadata === "object" ? (metadata as ConnectionMetadata) : null;
};

// Mirror react-fate's `getNodeView`: a connection selection nests its per-node
// view under `items.node`; the live subscription wants that node view, not the
// connection wrapper.
export const getNodeView = <V extends View<any, any>>(selection: {items?: {node?: V}} | V): V => {
	const maybeView = (selection as {items?: {node?: V}}).items?.node;
	if (maybeView != null && typeof maybeView === "object") {
		for (const key of Object.keys(maybeView)) if (isViewTag(key)) return maybeView;
	}
	return selection as V;
};

/**
 * Pins a live-view subscription on a stable entity ref (e.g. the parent `Post` of
 * a comment thread, the parent `Term` of a definition list) for the mount
 * lifetime. The ref's id is stable across the child list's mutation churn, so this
 * subscription survives the churn and keeps the SSE connection alive.
 */
export function useLiveKeepAlive<TName extends string>(
	// `View<any, any>` mirrors react-fate's own `useLiveView<V extends View<any,
	// any>>` — the view is only forwarded to `subscribeLiveView`, never read
	// structurally here.
	view: View<any, any>,
	ref: ViewRef<TName> | null,
): void {
	const client = useFateClient();
	const id = ref?.id;
	const type = ref?.__typename;

	// Keyed on the ref's stable `id`/`type`, not the per-render `ref` object — the
	// pin re-subscribes only on a genuine entity change, which is its whole point.
	useEffect(() => {
		if (ref == null) return;
		return client.subscribeLiveView(view, ref);
	}, [client, view, id, type]);
}

/**
 * Pins a live-list subscription on a connection's `listKey` for the mount
 * lifetime. For a feed with no single parent entity (the pano feed), the
 * connection's `listKey` is the stable identity to pin on.
 *
 * The first non-null metadata is *latched*: `useRequest` can return the connection
 * as a plain array (no `ConnectionTag`) during an in-flight refetch, transiently
 * dropping `metadata` to null — exactly the window the primary `useLiveListView`
 * effect tears down in. Latching the first resolved metadata keeps the pin's
 * subscription up through that gap (the `listKey` is filter-scoped and stable, so
 * the latched value stays correct for the mounted filter).
 */
export function useLiveListKeepAlive<V extends View<any, any>>(
	selection: {items?: {node?: V}} | V,
	connection: unknown,
): void {
	const client = useFateClient();
	const nodeView = useMemo(() => getNodeView(selection), [selection]);
	const latched = useRef<ConnectionMetadata | null>(null);
	if (latched.current == null) latched.current = connectionMetadataOf(connection);
	const metadata = latched.current;
	const key = metadata?.key;

	// Keyed on the latched `listKey`, so the pin survives the refetch window that
	// re-keys (and tears down) the primary `useLiveListView` effect.
	useEffect(() => {
		if (metadata == null) return;
		return client.subscribeLiveListView(nodeView, metadata);
	}, [client, nodeView, key]);
}
