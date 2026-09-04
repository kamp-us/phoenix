/**
 * The on-ramp's gating + copy contracts (#1210). The load-bearing one is the gate:
 * showing for a yazar (whose entries publish directly) would falsify the
 * honest-framing copy.
 */
import {describe, expect, it} from "vitest";
import {en} from "../../i18n/en";
import {tr} from "../../i18n/tr";
import {onrampHeadingKey, shouldShowOnramp} from "./FirstContributionOnramp";

const SURFACES = ["sozluk", "pano", "pano-comment"] as const;

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

describe("onrampHeadingKey — per-surface copy", () => {
	it("uses the tanım noun on the sözlük surface", () => {
		expect(tr[onrampHeadingKey("sozluk")]).toBe("ilk tanımını yazmaya hazırsın");
	});

	it("uses the gönderi noun on the pano surface", () => {
		expect(tr[onrampHeadingKey("pano")]).toBe("ilk gönderini paylaşmaya hazırsın");
	});

	it("uses the yorum noun on the pano comment surface", () => {
		expect(tr[onrampHeadingKey("pano-comment")]).toBe("ilk yorumunu yazmaya hazırsın");
	});

	it("gives every surface its own heading — no surface reuses another's noun", () => {
		const keys = SURFACES.map((s) => onrampHeadingKey(s));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("keeps the Turkish heading lowercase (user-facing convention)", () => {
		for (const surface of SURFACES) {
			const heading = tr[onrampHeadingKey(surface)];
			expect(heading).toBe(heading.toLocaleLowerCase("tr-TR"));
		}
	});

	it("answers in English too", () => {
		for (const surface of SURFACES) {
			expect(en[onrampHeadingKey(surface)]).toBeTruthy();
		}
	});
});
