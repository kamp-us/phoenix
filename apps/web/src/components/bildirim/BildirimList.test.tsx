/**
 * Regression for #2982: the list's live-reconcile must read the unread count through the
 * seed-gated, NON-suspending `useBildirimUnread`, not a suspending `useLiveView(channelRef)`
 * whose `byId` 500s (#2206) and rendered the popover's generic error.
 *
 * The `react-fate` mock below deliberately omits a `useLiveView` export, so reintroducing
 * the suspending channel read fails the import outright.
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
	view: () => (selection: unknown) => selection,
	useRequest: () => ({"bildirim.list": {}}),
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
		expect(useBildirimUnread).toHaveBeenCalledWith(true, "user-1");
	});

	it("refetches the list (network-only) when the live unread count bumps", () => {
		liveUnread = 1;
		const {rerender} = render(<BildirimList />);
		expect(requestSpy).not.toHaveBeenCalled();

		liveUnread = 3;
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
