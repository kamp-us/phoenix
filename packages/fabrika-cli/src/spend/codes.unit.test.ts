import {describe, expect, it} from "vitest";
import {allocatedCodes} from "../exit-code-alignment.ts";
import * as codes from "./codes.ts";

/**
 * What only this group owes. That no verb file seats a code of its own, and that the shared seats
 * carry the base's numbers, are checked for every group in `../exit-code-alignment.unit.test.ts`.
 */
describe("the `spend` group allocates from one table", () => {
	it("finds codes at all, so no assertion below passes over an empty table", () => {
		expect(allocatedCodes(codes).size).toBeGreaterThan(0);
	});

	it("seats one meaning on each number", () => {
		const shared = [...allocatedCodes(codes)].filter(([, names]) => names.length > 1);
		expect(shared).toEqual([]);
	});

	it("keeps every code in the band a verb owns for outcomes it proved", () => {
		for (const code of allocatedCodes(codes).keys()) expect(code).toBeGreaterThanOrEqual(3);
	});
});
