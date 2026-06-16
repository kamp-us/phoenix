import {describe, expect, it} from "vitest";
import {slugifyTerm} from "./slugifyTerm";

describe("slugifyTerm", () => {
	it("lowercases and joins words with hyphens", () => {
		expect(slugifyTerm("Race Condition")).toBe("race-condition");
	});

	it("folds Turkish diacritics to ASCII (matches existing term slugs)", () => {
		expect(slugifyTerm("önbellek")).toBe("onbellek");
		expect(slugifyTerm("yatay ölçekleme")).toBe("yatay-olcekleme");
		expect(slugifyTerm("kimlik doğrulama")).toBe("kimlik-dogrulama");
		expect(slugifyTerm("İŞÇİ")).toBe("isci");
	});

	it("collapses runs of separators and trims leading/trailing hyphens", () => {
		expect(slugifyTerm("  hello   world  ")).toBe("hello-world");
		expect(slugifyTerm("a / b — c")).toBe("a-b-c");
		expect(slugifyTerm("--edge--")).toBe("edge");
	});

	it("drops characters that aren't alphanumeric", () => {
		expect(slugifyTerm("c++ vs c#")).toBe("c-vs-c");
		expect(slugifyTerm("idempotent!")).toBe("idempotent");
	});

	it("keeps digits", () => {
		expect(slugifyTerm("base 64")).toBe("base-64");
	});

	it("returns an empty string when nothing slug-worthy remains", () => {
		expect(slugifyTerm("   ")).toBe("");
		expect(slugifyTerm("!!!")).toBe("");
	});
});
