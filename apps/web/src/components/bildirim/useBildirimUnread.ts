/**
 * `useBildirimUnread` — the topbar badge's LIVE unread-count read (#1694 read,
 * #1700 live). The count lives on the per-recipient `NotificationChannel` entity
 * (keyed by the viewer's user id); recording a notification republishes that
 * entity over `/fate/live` (`Notification.publishChannel`), so the badge moves the
 * moment a notification lands — no page refresh, no nav.
 *
 * The badge renders in the `Layout` shell ABOVE any `<Screen>` Suspense boundary,
 * so it can't call react-fate's suspending `useLiveView`. This drives the live
 * read itself, the shape of `useGlobalLivePin` + `useView`'s reactive core: seed
 * the channel ref with one imperative request, subscribe the entity live (which
 * keeps the shared SSE warm and merges every published frame into the cache), and
 * re-read the merged count reactively via `useSyncExternalStore` over the store's
 * per-entity subscription. Disabled (flag off / signed out) reports 0, so the
 * badge simply doesn't render — the safe/off path.
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

/** Read the channel's merged snapshot from the cache, or `null` if not yet loaded. */
function readChannel(
	client: ReturnType<typeof useFateClient>,
	userId: string,
): ChannelSnapshot | null {
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

	// Seed the channel entity into the cache, then hold the live subscription open
	// while the badge is enabled: it keeps the shared native SSE warm and merges
	// each published `NotificationChannel` frame into the store, which the reactive
	// read below picks up. Torn down when the badge disables (flag off / sign-out).
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

	// The reactive read: subscribe the store for every entity the channel snapshot
	// covers and re-read the merged `unreadCount` on each change — `useView`'s
	// coverage-driven subscription, hoisted above Suspense (synchronous read; a
	// not-yet-loaded ref reads 0).
	const getSnapshot = useCallback(
		() => (canRead && userId != null ? readChannel(client, userId) : null),
		[client, canRead, userId],
	);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			void seeded; // re-establish the subscription once the seed populates coverage
			if (!canRead || userId == null) return () => {};
			const subscriptions = new Map<string, () => void>();
			const sync = () => {
				const snapshot = readChannel(client, userId);
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
