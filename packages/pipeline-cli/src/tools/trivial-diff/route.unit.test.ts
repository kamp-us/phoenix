import {describe, expect, it} from "vitest";
import {type RouteInput, selectReviewTier} from "./route.ts";

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
	trivialTierEnabled: true,
	classifierOk: true,
	verdict: "trivial",
	...over,
});

describe("selectReviewTier — default-deny tier routing (ADR 0120 §3)", () => {
	it("routes an enabled + OK + `trivial` classification to the lighter gate (the ONLY positive case)", () => {
		expect(selectReviewTier(input())).toBe("lighter");
	});

	// Every fallback case must resolve to the full fan-out — a miss over-pays, never under-gates.
	it("falls back to full on a `non-trivial` verdict", () => {
		expect(selectReviewTier(input({verdict: "non-trivial"}))).toBe("full");
	});

	it("falls back to full when the classifier did not run OK, even if the verdict word is `trivial`", () => {
		expect(selectReviewTier(input({classifierOk: false}))).toBe("full");
	});

	it("falls back to full when the tier is disabled (its default — no-op until #1560 authorizes the flip)", () => {
		expect(selectReviewTier(input({trivialTierEnabled: false}))).toBe("full");
	});

	it("falls back to full on an unrecognized / ambiguous verdict word", () => {
		expect(selectReviewTier(input({verdict: ""}))).toBe("full");
		expect(selectReviewTier(input({verdict: "unknown"}))).toBe("full");
		expect(selectReviewTier(input({verdict: "TRIVIAL"}))).toBe("full");
	});

	it("requires the FULL conjunction — no single true flag selects the lighter path", () => {
		expect(
			selectReviewTier({trivialTierEnabled: true, classifierOk: false, verdict: "non-trivial"}),
		).toBe("full");
		expect(
			selectReviewTier({trivialTierEnabled: false, classifierOk: true, verdict: "trivial"}),
		).toBe("full");
		expect(
			selectReviewTier({trivialTierEnabled: false, classifierOk: false, verdict: "trivial"}),
		).toBe("full");
	});
});
