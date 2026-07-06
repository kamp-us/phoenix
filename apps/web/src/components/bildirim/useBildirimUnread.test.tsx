/**
 * Regression pin for #2206: the topbar unread badge must NEVER issue a `byId` against
 * the loader-less `NotificationChannel` synthetic source — a `byId` there 500s through
 * fate's capability-less error arm, and this badge mounts on every authenticated page,
 * so an ungated read was 500-spam on 100% of authed pageviews.
 *
 * `client.readView` is exactly the call that fetches a `byId` on a cache miss (fate's
 * `readView` → `fetchByIdAndNormalize` when `missing.size > 0`). The fix gates the read
 * behind the `bildirim.channel` query seed, so `readView` is only ever called once the
 * channel is hydrated (a pure cache hit, no `byId`). The stub client below records every
 * `readView`, and the load-bearing assertion is that it is NOT invoked before the seed
 * resolves — pre-fix, `getSnapshot` called `readView` on the first synchronous render
 * (empty cache → `byId` → 500).
 */
import {act, renderHook, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient} from "react-fate";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {useBildirimUnread} from "./useBildirimUnread";

const USER = "user-1";
const ENTITY = `NotificationChannel:${USER}`;

// A fake fate client modeling the one behavior that matters for #2206: `readView` is the
// call that fires a `byId` on a cache miss. Here it returns a PENDING thenable while the
// channel is unhydrated (the real client's cache-miss branch that fetches the byId) and a
// stable fulfilled snapshot once the `bildirim.channel` seed has resolved. A `readView`
// call while unhydrated == the byId 500 path; the test asserts it never happens.
function makeClient(unreadCount: number) {
	let hydrated = false;
	let resolveSeed!: () => void;
	const seed = new Promise<void>((r) => {
		resolveSeed = r;
	});
	// A single stable snapshot object — `useSyncExternalStore` requires getSnapshot to
	// return a cached reference when nothing changed (the real client memoizes via its
	// view-data cache); a fresh object each call would loop.
	const snapshot = {
		coverage: [[ENTITY, new Set(["unreadCount"])]] as ReadonlyArray<
			readonly [string, ReadonlySet<string>]
		>,
		data: {unreadCount},
	};
	const fulfilled = {status: "fulfilled" as const, value: snapshot};
	// Unhydrated → a bare pending thenable (fate's cache-miss branch, which fires the byId);
	// hydrated → the stable fulfilled snapshot (a pure cache hit).
	const readView = vi.fn(() => (hydrated ? fulfilled : Promise.resolve(null)));
	const request = vi.fn(() =>
		seed.then(() => {
			hydrated = true;
		}),
	);
	const client = {
		request,
		assertLiveViewSupport: vi.fn(),
		subscribeLiveView: vi.fn(() => () => undefined),
		ref: vi.fn((type: string, id: string) => ({__typename: type, id})),
		readView,
		store: {subscribe: vi.fn(() => () => undefined)},
	};
	return {client, readView, request, resolveSeed};
}

function wrapperFor(client: unknown) {
	return function wrapper({children}: {children: ReactNode}) {
		return <FateClient client={client as never}>{children}</FateClient>;
	};
}

describe("useBildirimUnread — no byId against the loader-less NotificationChannel source (#2206)", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not read (and so never fetches a byId) until the query seed hydrates the cache", async () => {
		const {client, readView, request, resolveSeed} = makeClient(3);
		const {result} = renderHook(() => useBildirimUnread(true, USER), {
			wrapper: wrapperFor(client),
		});

		// The seed request fired, but the reactive read did NOT — a readView on the empty
		// cache is exactly the byId that 500s. This is the regression: pre-fix the first
		// synchronous getSnapshot called readView before any hydration.
		expect(request).toHaveBeenCalledWith({"bildirim.channel": {view: expect.anything()}});
		expect(readView).not.toHaveBeenCalled();
		expect(result.current).toBe(0);

		// Resolve the seed → the cache hydrates → now the read is a pure cache hit and the
		// badge reflects the live count. The read path still works: no regression to #1700.
		await act(async () => {
			resolveSeed();
			await Promise.resolve();
		});
		await waitFor(() => expect(result.current).toBe(3));
		expect(readView).toHaveBeenCalled();
	});

	it("stays at 0 and never touches the wire while disabled (signed-out / flag off)", () => {
		const {client, readView, request} = makeClient(5);
		const {result} = renderHook(() => useBildirimUnread(false, null), {
			wrapper: wrapperFor(client),
		});
		expect(result.current).toBe(0);
		expect(request).not.toHaveBeenCalled();
		expect(readView).not.toHaveBeenCalled();
	});
});
