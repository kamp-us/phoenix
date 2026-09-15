/**
 * Which fate request mode a paginated feed asks for.
 *
 * `stale-while-revalidate` re-issues the ROOT request on every mount, and fate normalizes
 * that answer with `mergeListState(..., {replace: true})` (`@nkzw/fate@1.3.1`
 * `lib/index.mjs`, `fetchListAndNormalize`), which drops the ids the response did not
 * carry. So a page-one revalidation REPLACES the cached window: a feed that paged to 40
 * rows is 20 again the moment it remounts — on every back-navigation out of a post (#9266).
 *
 * `cache-first` never replaces that window: with page-one coverage already in the store it
 * issues no request at all. So read from cache once the reader has paged past page one —
 * the cache is then the wider truth, and throwing it away to refresh its first page is the
 * defect, not the refresh.
 *
 * Reading from cache buys that window at the cost of freshness, so it is bounded to the
 * window this tab itself fetched: the FIRST mount of a feed in a tab always revalidates,
 * whatever the cache already holds. That matters because a persisted snapshot
 * (`snapshot.ts`) restores the last window from `localStorage` with no age bound, so
 * without this a reader who once paged to 40 rows would boot days later straight onto those
 * stored rows and issue no request at all. Nothing would correct that paint for a signed-out
 * reader: the live subscription only refreshes rows for an authenticated client — an
 * anonymous one is grafted no-op `subscribeById`/`subscribeConnection` (`fate/client.ts`).
 * After that first revalidation the window is this session's, and keeping it costs nothing
 * the reader did not just load.
 */
import * as React from "react";

export const REVALIDATE_FEED = {mode: "stale-while-revalidate"} as const;

export type FeedRequestMode = typeof REVALIDATE_FEED | undefined;

/**
 * `snapshotEnabled` is `FEED_SNAPSHOT_ENABLED`: with no persisted snapshot to refresh
 * there is nothing for the revalidate leg to do, so the feed reads cache-first throughout.
 */
export function feedRequestMode(
	snapshotEnabled: boolean,
	cachedRows: number,
	pageSize: number,
	fetchedInThisTab: boolean,
): FeedRequestMode {
	if (!snapshotEnabled) return undefined;
	if (!fetchedInThisTab) return REVALIDATE_FEED;
	return cachedRows > pageSize ? undefined : REVALIDATE_FEED;
}

/**
 * Which feeds a client has already revalidated, by feed key. It outlives the mount, which is
 * the whole point — the question is what happened earlier in this tab — and it hangs off the
 * client rather than off the module so two clients never read each other's history.
 */
const revalidatedFeeds = new WeakMap<object, Set<string>>();

function feedsRevalidatedBy(client: object): Set<string> {
	const seen = revalidatedFeeds.get(client);
	if (seen) return seen;
	const created = new Set<string>();
	revalidatedFeeds.set(client, created);
	return created;
}

/**
 * Latches the mode per feed identity. `cachedRows` grows the moment "daha fazla" lands, so
 * recomputing every render would flip a mounted feed from revalidating to cache-first
 * mid-life — a second request handle, a fresh unresolved promise, and a skeleton flash
 * over rows that are already painted. The decision is made once per feed and re-made only
 * when `feedKey` names a different feed.
 *
 * The revalidation is recorded after commit, never during the render that decided it: a
 * render that suspends and is thrown away fetches nothing, and marking it would let the next
 * mount read a stale stored window as if this tab had loaded it.
 */
export function useFeedRequestMode(
	client: object,
	feedKey: string,
	snapshotEnabled: boolean,
	cachedRows: () => number,
	pageSize: number,
): FeedRequestMode {
	const latched = React.useRef<{key: string; mode: FeedRequestMode} | null>(null);
	if (latched.current === null || latched.current.key !== feedKey) {
		latched.current = {
			key: feedKey,
			mode: feedRequestMode(
				snapshotEnabled,
				cachedRows(),
				pageSize,
				feedsRevalidatedBy(client).has(feedKey),
			),
		};
	}
	const mode = latched.current.mode;

	React.useEffect(() => {
		if (mode === REVALIDATE_FEED) feedsRevalidatedBy(client).add(feedKey);
	}, [client, feedKey, mode]);

	return mode;
}
