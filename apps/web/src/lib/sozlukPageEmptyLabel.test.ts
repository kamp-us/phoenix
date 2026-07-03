import {describe, expect, it} from "vitest";
import {sozlukPageEmptyLabel} from "./sozlukPageEmptyLabel";

describe("sozlukPageEmptyLabel", () => {
	it("scopes a letter-filter miss to the loaded first page, never the corpus", () => {
		// The AC3 invariant: the copy must NOT assert "<letter> harfinde terim yok" as a
		// fact about the whole corpus — it must name the "ilk sayfada" (first-page) scope.
		const label = sozlukPageEmptyLabel("k", "");
		expect(label).toContain("ilk sayfada");
		expect(label).not.toBe('"k" harfinde terim yok.');
		expect(label).toBe('"k" harfiyle başlayan terim ilk sayfada yok.');
	});

	it("scopes a query-filter miss to the loaded first page", () => {
		const label = sozlukPageEmptyLabel(undefined, "idempotent");
		expect(label).toContain("ilk sayfada");
		expect(label).toBe('"idempotent" ilk sayfada bulunamadı.');
	});

	it("prefers the query scope when both a letter and a query are active", () => {
		expect(sozlukPageEmptyLabel("k", "kademe")).toBe('"kademe" ilk sayfada bulunamadı.');
	});

	it("trims a whitespace-padded query before wording the copy", () => {
		expect(sozlukPageEmptyLabel(undefined, "  race  ")).toBe('"race" ilk sayfada bulunamadı.');
	});

	it("treats a whitespace-only query as no query (falls back to letter/neutral scope)", () => {
		expect(sozlukPageEmptyLabel("k", "   ")).toBe('"k" harfiyle başlayan terim ilk sayfada yok.');
		expect(sozlukPageEmptyLabel(undefined, "   ")).toBe("ilk sayfada terim yok.");
	});

	it("falls back to a neutral first-page-scoped copy with no letter and no query", () => {
		expect(sozlukPageEmptyLabel(undefined, "")).toBe("ilk sayfada terim yok.");
	});
});
