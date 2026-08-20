/**
 * The on-ramp's gating + copy contracts (#1210). The load-bearing one is the gate:
 * showing for a yazar (whose entries publish directly) would falsify the
 * honest-framing copy.
 */
import {describe, expect, it} from "vitest";
import {onrampCopy, shouldShowOnramp} from "./FirstContributionOnramp";

describe("shouldShowOnramp — the çaylak-only gate", () => {
	it("shows only when the viewer is a çaylak", () => {
		expect(shouldShowOnramp("çaylak")).toBe(true);
	});

	it("never shows for a yazar — their entries are not sandboxed", () => {
		expect(shouldShowOnramp("yazar")).toBe(false);
	});

	it("never shows for a visitor (signed-out / no account)", () => {
		expect(shouldShowOnramp("visitor")).toBe(false);
	});

	it("stays dark while the tier is unknown (me not yet loaded / signed out)", () => {
		expect(shouldShowOnramp(undefined)).toBe(false);
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

	it("uses the yorum noun on the pano comment surface", () => {
		const copy = onrampCopy("pano-comment");
		expect(copy.heading).toBe("ilk yorumunu yazmaya hazırsın");
	});

	it("gives every surface its own heading — no surface reuses another's noun", () => {
		const headings = (["sozluk", "pano", "pano-comment"] as const).map(
			(s) => onrampCopy(s).heading,
		);
		expect(new Set(headings).size).toBe(headings.length);
	});

	it("keeps the heading lowercase (Turkish user-facing convention)", () => {
		for (const surface of ["sozluk", "pano", "pano-comment"] as const) {
			const {heading} = onrampCopy(surface);
			expect(heading).toBe(heading.toLocaleLowerCase("tr-TR"));
		}
	});
});
