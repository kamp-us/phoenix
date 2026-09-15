/**
 * Which fate request mode a paginated feed asks for.
 *
 * `stale-while-revalidate` re-issues the ROOT request on every mount, and fate normalizes
 * that answer with `mergeListState(..., {replace: true})` (`@nkzw/fate@1.3.1`
 * `lib/index.mjs`, `fetchListAndNormalize`), which drops the ids the response did not
 * carry. So a page-one revalidation REPLACES the cached window: a feed that paged to 40
 * rows is 20 again the moment it remounts — on every back-navigation out of a post, and
 * on every boot from a persisted snapshot that held more than one page (#9266).
 *
 * `cache-first` never replaces that window: with page-one coverage already in the store it
 * issues no request at all. So revalidate only while page one IS the whole window, and
 * read from cache once the reader has paged past it — the cache is then the wider truth,
 * and throwing it away to refresh its first page is the defect, not the refresh.
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
): FeedRequestMode {
	if (!snapshotEnabled) return undefined;
	return cachedRows > pageSize ? undefined : REVALIDATE_FEED;
}

/**
 * Latches the mode per feed identity. `cachedRows` grows the moment "daha fazla" lands, so
 * recomputing every render would flip a mounted feed from revalidating to cache-first
 * mid-life — a second request handle, a fresh unresolved promise, and a skeleton flash
 * over rows that are already painted. The decision is made once per feed and re-made only
 * when `feedKey` names a different feed.
 */
export function useFeedRequestMode(
	feedKey: string,
	snapshotEnabled: boolean,
	cachedRows: () => number,
	pageSize: number,
): FeedRequestMode {
	const latched = React.useRef<{key: string; mode: FeedRequestMode} | null>(null);
	if (latched.current === null || latched.current.key !== feedKey) {
		latched.current = {
			key: feedKey,
			mode: feedRequestMode(snapshotEnabled, cachedRows(), pageSize),
		};
	}
	return latched.current.mode;
}
