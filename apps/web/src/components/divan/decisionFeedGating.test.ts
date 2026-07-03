/**
 * Decision-feed render-decision units (#1704) — DOM-free, the `divanGating.test.ts`
 * idiom. The gates asserted: the decision copy maps the closed resolution set, the
 * resolver byline is first-class (handle → `@handle`, unresolved → generic "moderatör",
 * never a raw id), and only a `removed` decision is restorable.
 */
import {describe, expect, it} from "vitest";
import {decisionLabel, isRestorable, resolverLabel} from "./decisionFeedGating";

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
