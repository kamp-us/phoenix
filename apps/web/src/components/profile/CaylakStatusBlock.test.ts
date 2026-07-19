/**
 * The çaylak status block's gating, copy, and one-way-glass contracts (#1291),
 * asserted DOM-free — `apps/web/src` has no jsdom, so the gate, the vouch readout,
 * and the consumed-shape key set are factored out of the component and tested as
 * pure values (the pure-extraction idiom of `flagGateChild` / `shouldShowOnramp`).
 */
import {describe, expect, it} from "vitest";
import {
	caylakPromotionPath,
	STANDING_FIELDS,
	shouldShowCaylakStatus,
	VOUCH_NEEDED_COPY,
	vouchExistsLabel,
} from "./CaylakStatusBlock";

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

	it("keeps the readout lowercase Turkish", () => {
		for (const v of [true, false]) {
			const label = vouchExistsLabel(v);
			expect(label).toBe(label.toLocaleLowerCase("tr-TR"));
		}
	});
});

describe("caylakPromotionPath — the unvouched-vs-vouched rendering split (#1323)", () => {
	it("an UNVOUCHED çaylak gets the vouch-needed framing, NOT a karma bar (no karma-auto-promotion)", () => {
		const path = caylakPromotionPath(false);
		expect(path.kind).toBe("vouch-needed");
		if (path.kind === "vouch-needed") {
			expect(path.message).toBe(VOUCH_NEEDED_COPY.message);
			expect(path.hint).toBe(VOUCH_NEEDED_COPY.hint);
		}
	});

	it("a VOUCHED çaylak keeps the real reduced karma bar (the already-honest path) — unchanged", () => {
		expect(caylakPromotionPath(true)).toEqual({kind: "karma-bar"});
	});

	it("never carries promotion copy on the karma-bar branch (invalid state unrepresentable)", () => {
		expect(caylakPromotionPath(true)).not.toHaveProperty("message");
	});

	it("the unvouched copy communicates that a vouch (or a mod action) is required", () => {
		// the vouch path ('kefil') and the mod alternative are both surfaced
		expect(VOUCH_NEEDED_COPY.message).toMatch(/kefil/);
		expect(VOUCH_NEEDED_COPY.hint).toMatch(/moderatör/);
	});

	it("keeps the unvouched copy lowercase Turkish (karma is a brand noun)", () => {
		for (const text of [VOUCH_NEEDED_COPY.message, VOUCH_NEEDED_COPY.hint]) {
			expect(text).toBe(text.toLocaleLowerCase("tr-TR"));
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
