import {describe, expect, it} from "vitest";
import {sozlukPageEmptyLabel} from "./sozlukPageEmptyLabel";

describe("sozlukPageEmptyLabel", () => {
	it("scopes a letter-filter miss to the loaded first page, never the corpus", () => {
		// The invariant: the copy must NOT assert "<letter> harfinde terim yok" as a fact
		// about the whole corpus — it must name the "ilk sayfada" (first-page) scope.
		const label = sozlukPageEmptyLabel("k");
		expect(label).toContain("ilk sayfada");
		expect(label).not.toBe('"k" harfinde terim yok.');
		expect(label).toBe('"k" harfiyle başlayan terim ilk sayfada yok.');
	});

	it("falls back to a neutral first-page-scoped copy with no letter", () => {
		expect(sozlukPageEmptyLabel(undefined)).toBe("ilk sayfada terim yok.");
	});
});
