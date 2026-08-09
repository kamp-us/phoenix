import {describe, expect, it} from "vitest";
import {goldenUrl, parsePointer} from "./pointer.ts";

const SHA = "9c41f2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e";

describe("parsePointer", () => {
	it("reads the store and every surface's content address", () => {
		const parsed = parsePointer(
			JSON.stringify({store: "https://depo.example/", surfaces: {"/pano": {sha256: SHA}}}),
		);
		expect(parsed).toEqual({
			_tag: "Pointer",
			pointer: {store: "https://depo.example", surfaces: {"/pano": SHA}},
		});
	});

	/** Phoenix's shipped pointer predates the `store` key while the corpus is empty. */
	it("accepts an empty surfaces map with no store", () => {
		expect(parsePointer('{"surfaces":{}}')).toEqual({
			_tag: "Pointer",
			pointer: {store: null, surfaces: {}},
		});
	});

	it("carries repo-owned entry fields through rather than refusing them", () => {
		const parsed = parsePointer(
			JSON.stringify({
				store: "https://depo.example",
				surfaces: {"/pano": {sha256: SHA, blessedDate: "2026-08-09", intent: "the feed"}},
			}),
		);
		expect(parsed._tag).toBe("Pointer");
	});

	it.each([
		["bytes that are not JSON", "{", "the file is not JSON"],
		[
			"surfaces without a store — the blessed bytes are unreachable",
			JSON.stringify({surfaces: {"/pano": {sha256: SHA}}}),
			'it names surfaces but carries no "store"',
		],
		[
			"a sha that is not a content address",
			JSON.stringify({store: "https://depo.example", surfaces: {"/pano": {sha256: `${SHA}.png`}}}),
			"is not a 64-hex content address",
		],
	])("refuses %s", (_label, text, fragment) => {
		const parsed = parsePointer(text);
		expect(parsed._tag).toBe("Violation");
		if (parsed._tag !== "Violation") return;
		expect(parsed.violation).toContain(fragment);
	});
});

describe("goldenUrl", () => {
	it("resolves bytes content-addressed under the store", () => {
		expect(goldenUrl("https://depo.example", SHA)).toBe(`https://depo.example/${SHA}.png`);
	});
});
