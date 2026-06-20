import {describe, expect, it} from "vitest";
import {sozlukLetterHref} from "./sozlukLetterHref";

describe("sozlukLetterHref", () => {
	it("links an inactive letter to its per-letter index URL", () => {
		expect(sozlukLetterHref("a", false)).toBe("/sozluk?harf=a");
	});

	it("links the active letter back to bare /sozluk so it toggles off", () => {
		expect(sozlukLetterHref("a", true)).toBe("/sozluk");
	});

	it("percent-encodes Turkish letters in the query value", () => {
		expect(sozlukLetterHref("ç", false)).toBe(`/sozluk?harf=${encodeURIComponent("ç")}`);
		expect(sozlukLetterHref("ş", false)).toBe(`/sozluk?harf=${encodeURIComponent("ş")}`);
		expect(sozlukLetterHref("ı", false)).toBe(`/sozluk?harf=${encodeURIComponent("ı")}`);
	});
});
