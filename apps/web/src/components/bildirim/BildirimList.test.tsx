/**
 * Regression for #2982 (topbar popover "yüklenemedi"). The list's live-reconcile must
 * read the viewer's unread count through the seed-gated, NON-suspending `useBildirimUnread`
 * — NOT a suspending `useLiveView(channelRef)`. The suspending read's `readView` fires a
 * `byId` against the loader-less `NotificationChannel` synthetic source on any cache miss,
 * which 500s as `INTERNAL_ERROR` (#2206) and rendered the popover's generic error. These
 * pin the byId-safe wiring: the count comes from `useBildirimUnread`, and an unread bump
 * refetches the list (network-only) — the #1700 freshness behavior, preserved.
 *
 * `react-fate` and `useBildirimUnread` are mocked so this measures BildirimList's reconcile
 * wiring, not the fate cache; the loader-less-source byId-safety of `useBildirimUnread`
 * itself is pinned by its own suite (`useBildirimUnread.test.tsx`, #2206). Mocking
 * `react-fate` WITHOUT a `useLiveView` export also fails the import outright if the
 * suspending channel read is ever reintroduced here.
 */
import {render} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";

const requestSpy = vi.fn(() => Promise.resolve({}));
let sessionUserId: string | null = "user-1";
let liveUnread = 0;

vi.mock("../../auth/client", () => ({
	useSession: () => ({data: sessionUserId ? {user: {id: sessionUserId}} : null}),
}));

vi.mock("./useBildirimUnread", () => ({
	useBildirimUnread: vi.fn((_enabled: boolean, _userId: string | null) => liveUnread),
}));

vi.mock("react-fate", () => ({
	// A view factory usable at module load: `view<T>()(selection)` → the selection object.
	view: () => (selection: unknown) => selection,
	useRequest: () => ({"bildirim.list": {}}),
	// Empty connection → BildirimList renders its empty state (no rows, no useView needed).
	useListView: () => [[], null],
	useFateClient: () => ({request: requestSpy}),
	useView: (_view: unknown, node: unknown) => node,
	LoadMoreButton: () => null,
}));

import {BildirimList} from "./BildirimList";
import {useBildirimUnread} from "./useBildirimUnread";

afterEach(() => {
	requestSpy.mockClear();
	vi.mocked(useBildirimUnread).mockClear();
	sessionUserId = "user-1";
	liveUnread = 0;
});

describe("BildirimList live-reconcile — byId-safe (#2982 / #2206)", () => {
	it("reads the live unread count via the seed-gated useBildirimUnread (never a suspending channel read)", () => {
		liveUnread = 2;
		render(<BildirimList />);
		// Enabled when signed in, keyed by the viewer's id — the byId-safe path.
		expect(useBildirimUnread).toHaveBeenCalledWith(true, "user-1");
	});

	it("refetches the list (network-only) when the live unread count bumps", () => {
		liveUnread = 1;
		const {rerender} = render(<BildirimList />);
		expect(requestSpy).not.toHaveBeenCalled();

		liveUnread = 3; // a recorded notification lands → count rises
		rerender(<BildirimList />);

		expect(requestSpy).toHaveBeenCalledTimes(1);
		expect(requestSpy).toHaveBeenCalledWith(expect.anything(), {mode: "network-only"});
	});

	it("does not refetch when the count is unchanged or drops (mark-read lowers it)", () => {
		liveUnread = 3;
		const {rerender} = render(<BildirimList />);
		liveUnread = 3;
		rerender(<BildirimList />);
		liveUnread = 1;
		rerender(<BildirimList />);
		expect(requestSpy).not.toHaveBeenCalled();
	});

	it("disables the live read when signed out (enabled=false, id=null)", () => {
		sessionUserId = null;
		render(<BildirimList />);
		expect(useBildirimUnread).toHaveBeenCalledWith(false, null);
	});
});
