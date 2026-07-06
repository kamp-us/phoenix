/**
 * The on-ramp's gating + copy contracts (#1210), asserted DOM-free — `apps/web/src`
 * has no jsdom, so the gate and the per-surface copy are factored out of the
 * component and tested as pure functions (the pure-extraction idiom of
 * `flagGateChild`).
 *
 * The load-bearing invariant is the AND-gate: the on-ramp shows ONLY for a çaylak
 * with the flag on, because only a çaylak's first entry is sandboxed — so the
 * honest-framing copy is truthful for a çaylak alone. A gate that showed for a
 * yazar (whose entries publish directly), or that ignored the flag, would falsify
 * the framing; these tests pin both halves.
 */
import {describe, expect, it} from "vitest";
import {onrampCopy, shouldShowOnramp} from "./FirstContributionOnramp";

describe("shouldShowOnramp — the çaylak-only AND-gate", () => {
	it("shows only when the flag is on AND the viewer is a çaylak", () => {
		expect(shouldShowOnramp(true, "çaylak")).toBe(true);
	});

	it("stays dark for a çaylak when the flag is off (today's behavior)", () => {
		expect(shouldShowOnramp(false, "çaylak")).toBe(false);
	});

	it("never shows for a yazar — their entries are not sandboxed", () => {
		expect(shouldShowOnramp(true, "yazar")).toBe(false);
	});

	it("never shows for a visitor (signed-out / no account)", () => {
		expect(shouldShowOnramp(true, "visitor")).toBe(false);
	});

	it("stays dark while the tier is unknown (me not yet loaded / signed out)", () => {
		expect(shouldShowOnramp(true, undefined)).toBe(false);
	});
});

describe("onrampCopy — per-surface lowercase-Turkish copy", () => {
	it("uses the tanım noun on the sözlük surface", () => {
		const copy = onrampCopy("sozluk");
		expect(copy.heading).toBe("ilk tanımını yazmaya hazırsın");
	});

	it("uses the gönderi noun on the pano surface", () => {
		const copy = onrampCopy("pano");
		expect(copy.heading).toBe("ilk gönderini paylaşmaya hazırsın");
	});

	it("keeps the heading lowercase (Turkish user-facing convention)", () => {
		for (const surface of ["sozluk", "pano"] as const) {
			const {heading} = onrampCopy(surface);
			expect(heading).toBe(heading.toLocaleLowerCase("tr-TR"));
		}
	});
});
