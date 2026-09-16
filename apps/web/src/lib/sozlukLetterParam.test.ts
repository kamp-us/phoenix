import {describe, expect, it} from "vitest";
import {sozlukLetterParam} from "./sozlukLetterParam";

describe("sozlukLetterParam", () => {
	it("accepts a lowercase alphabet letter unchanged", () => {
		expect(sozlukLetterParam("a")).toBe("a");
		expect(sozlukLetterParam("ç")).toBe("ç");
		expect(sozlukLetterParam("ş")).toBe("ş");
	});

	it("lowercases in Turkish: I is ı's page, İ is i's — never the ASCII fold", () => {
		expect(sozlukLetterParam("I")).toBe("ı");
		expect(sozlukLetterParam("İ")).toBe("i");
		expect(sozlukLetterParam("Ç")).toBe("ç");
	});

	it("refuses anything the strip does not index", () => {
		expect(sozlukLetterParam("q")).toBeNull();
		expect(sozlukLetterParam("w")).toBeNull();
		expect(sozlukLetterParam("42")).toBeNull();
		expect(sozlukLetterParam("ab")).toBeNull();
		expect(sozlukLetterParam("")).toBeNull();
		expect(sozlukLetterParam(undefined)).toBeNull();
	});
});
