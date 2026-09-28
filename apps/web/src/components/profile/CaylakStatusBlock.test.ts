// The gate, the vouch readout and the promotion path are factored out of the component and
// asserted as pure values. The aggregate-only selection is typed against the server's
// `AuthorshipStanding`, whose keys the worker's ONE-WAY-GLASS test pins.
import {describe, expect, it} from "vitest";
import {tr} from "../../i18n/tr";
import {
	caylakPromotionPath,
	shouldShowCaylakStatus,
	VOUCH_NEEDED_KEYS,
	vouchExistsLabelKey,
} from "./CaylakStatusBlock";

const vouchExistsLabel = (vouchExists: boolean) => tr[vouchExistsLabelKey(vouchExists)];
const VOUCH_NEEDED_COPY = {
	message: tr[VOUCH_NEEDED_KEYS.message],
	hint: tr[VOUCH_NEEDED_KEYS.hint],
};

describe("shouldShowCaylakStatus — the two-gate AND (çaylak + own profile)", () => {
	it("shows only when the viewer is a çaylak AND it is their own profile", () => {
		expect(shouldShowCaylakStatus("çaylak", true)).toBe(true);
	});

	it("never shows on another user's profile, even for a çaylak", () => {
		expect(shouldShowCaylakStatus("çaylak", false)).toBe(false);
	});

	it("never shows for a yazar (their work is not in the çaylak loop)", () => {
		expect(shouldShowCaylakStatus("yazar", true)).toBe(false);
	});

	it("never shows for a visitor (signed-out / no account)", () => {
		expect(shouldShowCaylakStatus("visitor", true)).toBe(false);
	});

	it("stays dark while the tier is unknown (me not yet loaded / signed out)", () => {
		expect(shouldShowCaylakStatus(undefined, true)).toBe(false);
	});
});

describe("vouchExistsLabel — a bare yes/no, never an identity", () => {
	it("reads 'var' when a vouch exists", () => {
		expect(vouchExistsLabel(true)).toBe("var");
	});

	it("reads 'yok' when no vouch exists", () => {
		expect(vouchExistsLabel(false)).toBe("yok");
	});
});

describe("caylakPromotionPath — the unvouched-vs-vouched rendering split (#1323)", () => {
	it("an UNVOUCHED çaylak gets the vouch-needed framing, NOT a karma bar (no karma-auto-promotion)", () => {
		const path = caylakPromotionPath(false);
		expect(path.kind).toBe("vouch-needed");
		if (path.kind === "vouch-needed") {
			expect(tr[path.messageKey]).toBe(VOUCH_NEEDED_COPY.message);
			expect(tr[path.hintKey]).toBe(VOUCH_NEEDED_COPY.hint);
		}
	});

	it("a VOUCHED çaylak keeps the real reduced karma bar (the already-honest path) — unchanged", () => {
		expect(caylakPromotionPath(true)).toEqual({kind: "karma-bar"});
	});

	it("the unvouched copy communicates that a vouch (or a mod action) is required", () => {
		expect(VOUCH_NEEDED_COPY.message).toMatch(/kefil/);
		expect(VOUCH_NEEDED_COPY.hint).toMatch(/moderatör/);
	});

	it("keeps the unvouched copy lowercase Turkish (karma is a brand noun)", () => {
		for (const text of [VOUCH_NEEDED_COPY.message, VOUCH_NEEDED_COPY.hint]) {
			expect(text).toBe(text.toLocaleLowerCase("tr-TR"));
		}
	});
});
