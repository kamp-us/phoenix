import {describe, expect, it} from "vitest";
import {
	NEUTRAL_OVERLAY,
	type OverlayState,
	PENDING_OVERLAY,
	resolveOverlay,
	type ViewerOverlay,
} from "./panoFeedOverlay";

const landed = (identity: string | null, entries: Record<string, ViewerOverlay>): OverlayState => ({
	status: "landed",
	identity,
	byId: new Map(Object.entries(entries)),
});

describe("resolveOverlay", () => {
	it("is neutral while the overlay is pending (base painted, scalars not yet landed)", () => {
		expect(resolveOverlay(PENDING_OVERLAY, "user-a", "p1")).toEqual(NEUTRAL_OVERLAY);
	});

	it("returns the row's scalars once landed under the matching identity", () => {
		const state = landed("user-a", {p1: {myVote: true, isSaved: false}});
		expect(resolveOverlay(state, "user-a", "p1")).toEqual({myVote: true, isSaved: false});
	});

	it("stays neutral for a base row the landed batch does not cover", () => {
		const state = landed("user-a", {p1: {myVote: true, isSaved: true}});
		expect(resolveOverlay(state, "user-a", "p2")).toEqual(NEUTRAL_OVERLAY);
	});

	// The load-bearing invariant (#2323 AC): a viewer never sees another identity's overlay.
	it("rejects an overlay landed under a DIFFERENT identity (never foreign state)", () => {
		const stateForA = landed("user-a", {p1: {myVote: true, isSaved: true}});
		expect(resolveOverlay(stateForA, "user-b", "p1")).toEqual(NEUTRAL_OVERLAY);
	});

	it("rejects a signed-in overlay for the anon viewer, and an anon overlay for a signed-in viewer", () => {
		const anonBatch = landed(null, {p1: {myVote: false, isSaved: false}});
		expect(resolveOverlay(anonBatch, "user-a", "p1")).toEqual(NEUTRAL_OVERLAY);
		const authedBatch = landed("user-a", {p1: {myVote: true, isSaved: true}});
		expect(resolveOverlay(authedBatch, null, "p1")).toEqual(NEUTRAL_OVERLAY);
	});

	it("resolves the anon viewer's own landed batch (identity null on both sides)", () => {
		const anonBatch = landed(null, {p1: {myVote: null, isSaved: null}});
		expect(resolveOverlay(anonBatch, null, "p1")).toEqual({myVote: null, isSaved: null});
	});
});
