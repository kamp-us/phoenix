import {describe, expect, it} from "vitest";
import {trCatalog} from "../i18n";
import {interpolate} from "../i18n/interpolate";
import {sozlukPageEmptyLabel} from "./sozlukPageEmptyLabel";

// The real `tr` catalog, not a stub: the #1669 invariant is a claim about the shipped copy, so a
// stub would let the catalog drift back to a corpus-scoped message with this test still green.
const t = (key: keyof typeof trCatalog, params?: Record<string, string | number>) =>
	interpolate(trCatalog[key], params);

describe("sozlukPageEmptyLabel", () => {
	it("scopes a letter-filter miss to the loaded first page, never the corpus", () => {
		const label = sozlukPageEmptyLabel(t, "k");
		expect(label).toContain("ilk sayfada");
		expect(label).not.toBe('"k" harfinde terim yok.');
		expect(label).toBe('"k" harfiyle başlayan terim ilk sayfada yok.');
	});

	it("falls back to a neutral first-page-scoped copy with no letter", () => {
		expect(sozlukPageEmptyLabel(t, undefined)).toBe("ilk sayfada terim yok.");
	});
});
