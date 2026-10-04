import {describe, expect, it} from "vitest";
import {
	DIVAN_PATH,
	DIVAN_RAPORLAR_PATH,
	divanSectionFromFilterId,
	divanSectionHref,
	visibleDivanSection,
} from "./divanSection";

describe("divan section hrefs", () => {
	it("gives each section a URL of its own", () => {
		expect(divanSectionHref("caylaklar")).toBe(DIVAN_PATH);
		expect(divanSectionHref("raporlar")).toBe(DIVAN_RAPORLAR_PATH);
	});

	it("reads the Subnav zone's filter id back as a section", () => {
		expect(divanSectionFromFilterId("raporlar")).toBe("raporlar");
		expect(divanSectionFromFilterId("caylaklar")).toBe("caylaklar");
		expect(divanSectionFromFilterId("bir-sey")).toBe("caylaklar");
	});
});

describe("visibleDivanSection — the moderator fold", () => {
	it("opens raporlar only for a moderator on the raporlar URL", () => {
		expect(visibleDivanSection("raporlar", true)).toBe("raporlar");
	});

	// The URL is not the entitlement: an unentitled reader who types or is linked the raporlar
	// path lands on the roster, same as before the path existed.
	it("folds the raporlar URL down to caylaklar for a non-moderator", () => {
		expect(visibleDivanSection("raporlar", false)).toBe("caylaklar");
	});

	it("leaves the roster URL alone for either viewer", () => {
		expect(visibleDivanSection("caylaklar", true)).toBe("caylaklar");
		expect(visibleDivanSection("caylaklar", false)).toBe("caylaklar");
	});
});
