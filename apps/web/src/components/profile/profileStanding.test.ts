import {describe, expect, it} from "vitest";
import {tr} from "../../i18n/tr";
import {profileStandingLabelKey} from "./profileStanding";

const profileStandingLabel = (tier: Parameters<typeof profileStandingLabelKey>[0]) => {
	const key = profileStandingLabelKey(tier);
	return key === null ? null : tr[key];
};

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
