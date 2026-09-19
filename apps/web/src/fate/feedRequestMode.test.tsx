/**
 * The mode decision and its latch, in isolation (#9266).
 *
 * The end-to-end guarantee — load a second page, leave, come back, still 40 rows — is asserted
 * against the page's own wiring in `pages/PanoFeed.test.tsx`, because a copy of that wiring
 * here would keep passing while the page pinned a mode back at the callsite.
 */
import {renderHook} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {feedRequestMode, REVALIDATE_FEED, useFeedRequestMode} from "./feedRequestMode";

describe("feedRequestMode", () => {
	it("always revalidates the first time this tab opens the feed", () => {
		expect(feedRequestMode(true, 0, 20, false)).toBe(REVALIDATE_FEED);
		// A window this wide came from a persisted snapshot, not from this tab. It has no age
		// bound, so refresh it rather than paint it.
		expect(feedRequestMode(true, 40, 20, false)).toBe(REVALIDATE_FEED);
	});

	it("revalidates while the cached window is at most one page", () => {
		expect(feedRequestMode(true, 0, 20, true)).toBe(REVALIDATE_FEED);
		expect(feedRequestMode(true, 20, 20, true)).toBe(REVALIDATE_FEED);
	});

	it("reads from cache once this tab has paged past the first page", () => {
		expect(feedRequestMode(true, 21, 20, true)).toBeUndefined();
		expect(feedRequestMode(true, 40, 20, true)).toBeUndefined();
	});

	it("never revalidates with no snapshot to refresh", () => {
		expect(feedRequestMode(false, 0, 20, false)).toBeUndefined();
		expect(feedRequestMode(false, 40, 20, true)).toBeUndefined();
	});
});

describe("useFeedRequestMode", () => {
	it("holds its decision while the reader pages, so a mounted feed never re-issues", () => {
		const client = {};
		let cached = 0;
		const {result, rerender} = renderHook(() =>
			useFeedRequestMode(client, "hot", true, () => cached, 20),
		);
		expect(result.current).toBe(REVALIDATE_FEED);

		// "daha fazla" lands: recomputing here would flip the mounted feed to cache-first, mount a
		// second request handle and flash a skeleton over rows that are already painted.
		cached = 40;
		rerender();
		expect(result.current).toBe(REVALIDATE_FEED);
	});

	it("reads from cache on the next mount, once this tab has revalidated the feed", () => {
		const client = {};
		let cached = 0;
		const first = renderHook(() => useFeedRequestMode(client, "hot", true, () => cached, 20));
		expect(first.result.current).toBe(REVALIDATE_FEED);
		first.unmount();

		cached = 40;
		const second = renderHook(() => useFeedRequestMode(client, "hot", true, () => cached, 20));
		expect(second.result.current).toBeUndefined();
	});

	it("keeps each feed's history to itself, and each client's to itself", () => {
		const client = {};
		renderHook(() => useFeedRequestMode(client, "hot", true, () => 0, 20)).unmount();

		// A different feed on the same client, and the same feed on a different client, are both
		// first mounts — a snapshot-wide window is refreshed rather than painted.
		expect(
			renderHook(() => useFeedRequestMode(client, "new", true, () => 40, 20)).result.current,
		).toBe(REVALIDATE_FEED);
		expect(renderHook(() => useFeedRequestMode({}, "hot", true, () => 40, 20)).result.current).toBe(
			REVALIDATE_FEED,
		);
	});
});
