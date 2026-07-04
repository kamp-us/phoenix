/**
 * Decision-feed render-decision units (#1704) — DOM-free, the `divanGating.test.ts`
 * idiom. The gates asserted: the decision copy maps the closed resolution set, the
 * resolver byline is first-class (handle → `@handle`, unresolved → generic "moderatör",
 * never a raw id), and only a `removed` decision is restorable.
 */
import {describe, expect, it} from "vitest";
import {
	decisionLabel,
	groupDecisionFeed,
	isRestorable,
	resolverLabel,
	waveEntryLabel,
} from "./decisionFeedGating";

describe("decisionLabel", () => {
	it("maps removed → kaldırıldı", () => {
		expect(decisionLabel("removed")).toBe("kaldırıldı");
	});
	it("maps dismissed → yoksayıldı", () => {
		expect(decisionLabel("dismissed")).toBe("yoksayıldı");
	});
});

describe("resolverLabel — the resolver is first-class", () => {
	it("renders a resolved handle as @handle", () => {
		expect(resolverLabel("founder")).toBe("@founder");
	});
	it("falls back to a generic moderatör when unresolved (never a raw id)", () => {
		expect(resolverLabel(null)).toBe("moderatör");
		expect(resolverLabel("   ")).toBe("moderatör");
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
	it("names the target count as 'N hedef · dalga'", () => {
		expect(waveEntryLabel(3)).toBe("3 hedef · dalga");
		expect(waveEntryLabel(1)).toBe("1 hedef · dalga");
	});
});
