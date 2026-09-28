import {describe, expect, it} from "vitest";
import {allocatedCodes} from "../exit-code-alignment.ts";
import * as codes from "./codes.ts";

/**
 * What only this group owes. That every verb file seats nothing of its own, that each shared seat
 * carries the base's number and that no private code lands on a base seat are checked for every
 * aligned group at once in `../exit-code-alignment.unit.test.ts`.
 */
describe("the `pattern` group allocates from one table", () => {
	it("finds codes at all, so no assertion below passes over an empty table", () => {
		expect(allocatedCodes(codes).size).toBeGreaterThan(0);
	});

	it("seats one meaning on each number", () => {
		expect([...allocatedCodes(codes)].filter(([, names]) => names.length > 1)).toEqual([]);
	});

	it("keeps every code in the band a verb owns for outcomes it proved", () => {
		for (const code of allocatedCodes(codes).keys()) expect(code).toBeGreaterThanOrEqual(3);
	});
});

/**
 * The five gaps, each pinned to the reason it is a gap rather than an oversight — and `7` above all.
 * No verb here judges over a corpus, so none has a vacuous pass to prevent: an empty or absent doc
 * directory is a fact reported at exit `0`, and refusing there would leave a repo adopting fabrika
 * unable to write its first pattern doc on the documented path.
 */
describe("the deliberate gaps stay gaps", () => {
	it("seats nothing on 3 through 7", () => {
		for (const code of [3, 4, 5, 6, 7]) expect(allocatedCodes(codes).has(code)).toBe(false);
	});
});
