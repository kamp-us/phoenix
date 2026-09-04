import {describe, expect, it} from "vitest";
import {
	decisionLabel,
	groupDecisionFeed,
	isRestorable,
	resolverHandle,
	waveEntryLabel,
} from "./decisionFeedGating";

describe("decisionLabel", () => {
	it("maps removed → the removed key", () => {
		expect(decisionLabel("removed")).toBe("divan.decision.removed");
	});
	it("maps dismissed → the dismissed key", () => {
		expect(decisionLabel("dismissed")).toBe("divan.decision.dismissed");
	});
});

describe("resolverHandle — the resolver is first-class", () => {
	it("renders a resolved handle as @handle", () => {
		expect(resolverHandle("founder")).toBe("@founder");
	});
	it("yields null when unresolved, so the row renders the catalog noun (never a raw id)", () => {
		expect(resolverHandle(null)).toBeNull();
		expect(resolverHandle("   ")).toBeNull();
	});
});

describe("isRestorable — only a removal can be brought back", () => {
	it("removed is restorable", () => {
		expect(isRestorable("removed")).toBe(true);
	});
	it("dismissed took no action → nothing to restore", () => {
		expect(isRestorable("dismissed")).toBe(false);
	});
});

describe("groupDecisionFeed — a wave collapses to one entry, lone removals stay individual", () => {
	it("keeps lone (null waveId) removals as their own single entries", () => {
		const entries = groupDecisionFeed([
			{id: "post:p1", waveId: null},
			{id: "comment:c1", waveId: null},
		]);
		expect(entries).toEqual([
			{kind: "single", id: "post:p1"},
			{kind: "single", id: "comment:c1"},
		]);
	});

	it("collapses rows sharing a waveId into ONE wave entry with its members in order", () => {
		const entries = groupDecisionFeed([
			{id: "post:p1", waveId: "wave-1"},
			{id: "post:p2", waveId: "wave-1"},
			{id: "definition:d1", waveId: "wave-1"},
		]);
		expect(entries).toEqual([
			{kind: "wave", waveId: "wave-1", memberIds: ["post:p1", "post:p2", "definition:d1"]},
		]);
	});

	it("anchors the wave at its first occurrence, interleaving lone removals by feed order", () => {
		const entries = groupDecisionFeed([
			{id: "post:p1", waveId: "wave-1"},
			{id: "comment:c9", waveId: null},
			{id: "post:p2", waveId: "wave-1"},
		]);
		expect(entries).toEqual([
			{kind: "wave", waveId: "wave-1", memberIds: ["post:p1", "post:p2"]},
			{kind: "single", id: "comment:c9"},
		]);
	});

	it("keeps two distinct waves as two separate entries", () => {
		const entries = groupDecisionFeed([
			{id: "post:p1", waveId: "wave-1"},
			{id: "post:p2", waveId: "wave-2"},
		]);
		expect(entries).toEqual([
			{kind: "wave", waveId: "wave-1", memberIds: ["post:p1"]},
			{kind: "wave", waveId: "wave-2", memberIds: ["post:p2"]},
		]);
	});
});

describe("waveEntryLabel — the batch byline", () => {
	it("names the target count, picking the plural arm off the count", () => {
		expect(waveEntryLabel(3)).toEqual({key: "divan.decision.wave.other", params: {count: 3}});
		expect(waveEntryLabel(1)).toEqual({key: "divan.decision.wave.one", params: {count: 1}});
	});
});
