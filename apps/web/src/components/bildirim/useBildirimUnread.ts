/**
 * `useBildirimUnread` — the topbar badge's live unread-count read (#1694, #1700).
 *
 * The badge renders in the `Layout` shell ABOVE any `<Screen>` Suspense boundary,
 * so it can't call react-fate's suspending `useLiveView`. It drives the live read
 * itself instead: seed the channel ref with one imperative request, subscribe the
 * entity live, and re-read the merged count via `useSyncExternalStore`.
 */
import {useCallback, useEffect, useState, useSyncExternalStore} from "react";
import {useFateClient, view} from "react-fate";
import type {NotificationChannel} from "../../../worker/features/fate/views";

const ChannelView = view<NotificationChannel>()({
	id: true,
	unreadCount: true,
});

type ChannelSnapshot = {
	coverage: ReadonlyArray<readonly [string, ReadonlySet<string>]>;
	data: {unreadCount?: number} | null;
};

/**
 * Read the channel's merged snapshot from the cache, or `null` if not yet loaded.
 *
 * Reads ONLY once `seeded` — i.e. after the `bildirim.channel` query has hydrated the
 * channel into the cache. `NotificationChannel` is a loader-less `Fate.syntheticSource`
 * (no `byId`/`byIds`), and `client.readView` fetches a `byId` on a cache miss — which
 * takes fate's capability-less error arm and 500s. This badge mounts on every
 * authenticated page, so an ungated read is 500-spam on 100% of authed pageviews (#2206).
 * Gating the read behind the seed keeps `readView` a pure cache hit (`missing.size === 0`),
 * so the `byId` is never issued; the entity is delivered inline by the query and
 * reconciled live over `/fate/live`.
 */
function readChannel(
	client: ReturnType<typeof useFateClient>,
	userId: string,
	seeded: boolean,
): ChannelSnapshot | null {
	if (!seeded) return null;
	const ref = client.ref("NotificationChannel", userId, ChannelView);
	const thenable = client.readView(ChannelView, ref);
	return "status" in thenable && (thenable as {status?: unknown}).status === "fulfilled"
		? (((thenable as {value: ChannelSnapshot}).value ?? null) as ChannelSnapshot | null)
		: null;
}

export function useBildirimUnread(enabled: boolean, userId: string | null): number {
	const client = useFateClient();
	const canRead = enabled && userId != null;
	// Bumped once the initial channel request has hydrated the cache; it re-keys the
	// store subscription below so it re-establishes over the now-populated coverage
	// (the seed's own hydrate fires before any store subscriber exists).
	const [seeded, setSeeded] = useState(0);

	// Holding the subscription open keeps the shared SSE warm and merges each published
	// `NotificationChannel` frame into the store, which the reactive read below picks up.
	useEffect(() => {
		if (!canRead || userId == null) return;
		let unsubscribe: (() => void) | undefined;
		let cancelled = false;
		void client
			.request({"bildirim.channel": {view: ChannelView}})
			.then(() => {
				if (cancelled) return;
				setSeeded((n) => n + 1);
				client.assertLiveViewSupport();
				unsubscribe = client.subscribeLiveView(
					ChannelView,
					client.ref("NotificationChannel", userId, ChannelView),
				);
			})
			.catch((error: unknown) => {
				console.error("[useBildirimUnread] channel seed/subscribe failed", error);
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [client, canRead, userId]);

	const getSnapshot = useCallback(
		() => (canRead && userId != null ? readChannel(client, userId, seeded > 0) : null),
		[client, canRead, userId, seeded],
	);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			if (!canRead || userId == null) return () => {};
			const subscriptions = new Map<string, () => void>();
			const sync = () => {
				const snapshot = readChannel(client, userId, seeded > 0);
				const nextIds = new Set<string>();
				for (const [entityId, paths] of snapshot?.coverage ?? []) {
					nextIds.add(entityId);
					if (!subscriptions.has(entityId)) {
						subscriptions.set(entityId, client.store.subscribe(entityId, paths, onChange));
					}
				}
				for (const [entityId, unsub] of subscriptions) {
					if (!nextIds.has(entityId)) {
						unsub();
						subscriptions.delete(entityId);
					}
				}
			};
			const onChange = () => {
				sync();
				onStoreChange();
			};
			sync();
			return () => {
				for (const unsub of subscriptions.values()) unsub();
				subscriptions.clear();
			};
		},
		[client, canRead, userId, seeded],
	);

	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return snapshot?.data?.unreadCount ?? 0;
}
