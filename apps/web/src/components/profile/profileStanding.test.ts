/**
 * The profile-header standing-label contract (#1302), asserted DOM-free — the
 * per-tier mapping is factored out of `ProfilePage` and tested as a pure function
 * (the pure-extraction idiom of `shouldShowOnramp`).
 *
 * The load-bearing invariant is honesty: the subtitle must reflect the account's
 * real tier and NEVER fall back to a static lie like the `yeni üye` it replaces.
 * These tests pin both halves — the true per-tier label AND the null (handle-only)
 * fallback for every state with no honest label.
 */
import {describe, expect, it} from "vitest";
import {profileStandingLabel} from "./profileStanding";

describe("profileStandingLabel — the trusted-tier subtitle (#1302)", () => {
	it("labels a yazar with the glossary rank", () => {
		expect(profileStandingLabel("yazar")).toBe("yazar");
	});

	it("labels a çaylak with the glossary rank", () => {
		expect(profileStandingLabel("çaylak")).toBe("çaylak");
	});

	it("shows no label for the read-time visitor rank (never an honest account label)", () => {
		expect(profileStandingLabel("visitor")).toBeNull();
	});

	it("shows no label while the tier is unknown (me not yet loaded / errored)", () => {
		expect(profileStandingLabel(undefined)).toBeNull();
	});

	it("never reintroduces a static 'yeni üye' placeholder for any state", () => {
		for (const tier of ["visitor", "çaylak", "yazar", undefined] as const) {
			expect(profileStandingLabel(tier)).not.toBe("yeni üye");
		}
	});

	it("emits only lowercase-Turkish copy (user-facing convention)", () => {
		for (const tier of ["çaylak", "yazar"] as const) {
			const label = profileStandingLabel(tier);
			expect(label).not.toBeNull();
			expect(label).toBe(label?.toLocaleLowerCase("tr-TR"));
		}
	});
});
