import {describe, expect, it} from "vitest";
import {searchTarget} from "./searchTarget";

describe("searchTarget", () => {
	it("builds /search?q=<encoded> for a plain query", () => {
		expect(searchTarget("react")).toBe("/search?q=react");
	});

	it("trims surrounding whitespace before building the target", () => {
		expect(searchTarget("  react  ")).toBe("/search?q=react");
	});

	it("returns null for an empty query (a bare Enter must not navigate)", () => {
		expect(searchTarget("")).toBeNull();
	});

	it("returns null for a whitespace-only query", () => {
		expect(searchTarget("   ")).toBeNull();
	});

	it("returns null for a single-char query (below the 2-char minimum, ADR 0080)", () => {
		expect(searchTarget("a")).toBeNull();
		// a query that trims down to one char is also below the floor
		expect(searchTarget("  x ")).toBeNull();
	});

	it("encodes spaces in a multi-word query", () => {
		expect(searchTarget("yatay ölçekleme")).toBe("/search?q=yatay%20%C3%B6l%C3%A7ekleme");
	});

	it("encodes Turkish characters so they round-trip into the results page", () => {
		expect(searchTarget("öğrenci")).toBe(`/search?q=${encodeURIComponent("öğrenci")}`);
		const encoded = searchTarget("öğrenci")?.replace("/search?q=", "") ?? "";
		expect(decodeURIComponent(encoded)).toBe("öğrenci");
	});

	it("encodes URL-significant characters (&, #, ?) so they don't break the query string", () => {
		expect(searchTarget("a&b")).toBe("/search?q=a%26b");
		expect(searchTarget("c#d")).toBe("/search?q=c%23d");
		expect(searchTarget("e?f")).toBe("/search?q=e%3Ff");
	});
});
