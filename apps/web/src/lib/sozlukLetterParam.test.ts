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

	it("resolves q, w and x — and their capitals — to their own pages (#9425)", () => {
		expect(sozlukLetterParam("q")).toBe("q");
		expect(sozlukLetterParam("w")).toBe("w");
		expect(sozlukLetterParam("x")).toBe("x");
		expect(sozlukLetterParam("Q")).toBe("q");
		expect(sozlukLetterParam("W")).toBe("w");
		expect(sozlukLetterParam("X")).toBe("x");
	});

	it("refuses anything the strip does not index", () => {
		expect(sozlukLetterParam("42")).toBeNull();
		expect(sozlukLetterParam("ab")).toBeNull();
		expect(sozlukLetterParam("")).toBeNull();
		expect(sozlukLetterParam(undefined)).toBeNull();
	});
});
