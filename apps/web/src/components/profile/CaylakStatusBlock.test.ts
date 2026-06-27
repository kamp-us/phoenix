/**
 * The çaylak status block's gating, copy, and one-way-glass contracts (#1291),
 * asserted DOM-free — `apps/web/src` has no jsdom, so the gate, the vouch readout,
 * and the consumed-shape key set are factored out of the component and tested as
 * pure values (the pure-extraction idiom of `flagGateChild` / `shouldShowOnramp`).
 */
import {describe, expect, it} from "vitest";
import {shouldShowCaylakStatus, STANDING_FIELDS, vouchExistsLabel} from "./CaylakStatusBlock";

describe("shouldShowCaylakStatus — the three-gate AND (flag + çaylak + own profile)", () => {
	it("shows only when the flag is on AND the viewer is a çaylak AND it is their own profile", () => {
		expect(shouldShowCaylakStatus(true, "çaylak", true)).toBe(true);
	});

	it("stays dark when the flag is off (default / dark-ship)", () => {
		expect(shouldShowCaylakStatus(false, "çaylak", true)).toBe(false);
	});

	it("never shows on another user's profile, even for a çaylak with the flag on", () => {
		expect(shouldShowCaylakStatus(true, "çaylak", false)).toBe(false);
	});

	it("never shows for a yazar (their work is not in the çaylak loop)", () => {
		expect(shouldShowCaylakStatus(true, "yazar", true)).toBe(false);
	});

	it("never shows for a visitor (signed-out / no account)", () => {
		expect(shouldShowCaylakStatus(true, "visitor", true)).toBe(false);
	});

	it("stays dark while the tier is unknown (me not yet loaded / signed out)", () => {
		expect(shouldShowCaylakStatus(true, undefined, true)).toBe(false);
	});
});

describe("vouchExistsLabel — a bare yes/no, never an identity", () => {
	it("reads 'var' when a vouch exists", () => {
		expect(vouchExistsLabel(true)).toBe("var");
	});

	it("reads 'yok' when no vouch exists", () => {
		expect(vouchExistsLabel(false)).toBe("yok");
	});

	it("keeps the readout lowercase Turkish", () => {
		for (const v of [true, false]) {
			const label = vouchExistsLabel(v);
			expect(label).toBe(label.toLocaleLowerCase("tr-TR"));
		}
	});
});

describe("STANDING_FIELDS — one-way glass at the consumed shape", () => {
	it("selects ONLY the aggregate scalars + the id normalization key", () => {
		expect(Object.keys(STANDING_FIELDS).sort()).toEqual(
			["bar", "id", "inReviewCount", "karma", "vouchExists"].sort(),
		);
	});

	it("carries NO reviewer / voter / voucher identity field (the hard privacy invariant)", () => {
		const forbidden = [
			"reviewer",
			"reviewers",
			"reviewerId",
			"reviewedBy",
			"voter",
			"voters",
			"voterId",
			"votedBy",
			"voucher",
			"vouchers",
			"voucherId",
			"vouchedBy",
			"userId",
		];
		for (const key of Object.keys(STANDING_FIELDS)) {
			expect(forbidden).not.toContain(key);
		}
	});
});
