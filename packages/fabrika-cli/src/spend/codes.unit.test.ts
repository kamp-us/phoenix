import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {allocatedCodes, verbLocalCodesIn} from "../exit-code-alignment.ts";
import * as codes from "./codes.ts";

const GROUP_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * `spend` never collided with itself — its two verbs drew the same distinctions on two number lines
 * (#5294). These pin the property that made that luck rather than structure: one table, and the
 * three zero-shaped states on three codes.
 */
describe("the `spend` group allocates from one table", () => {
	it("leaves no verb module seating a code of its own", () => {
		expect(verbLocalCodesIn(GROUP_DIR)).toEqual([]);
	});

	it("finds codes at all, so no assertion below passes over an empty table (ADR 0092)", () => {
		expect(allocatedCodes(codes).size).toBeGreaterThan(0);
	});

	it("seats one meaning on each number", () => {
		const shared = [...allocatedCodes(codes)].filter(([, names]) => names.length > 1);
		expect(shared).toEqual([]);
	});

	it("keeps a proven absence, an UNKNOWN read and a measured nothing on three codes", () => {
		const zeroes = [codes.INPUT_ABSENT, codes.INPUT_UNREADABLE, codes.NOTHING_MEASURED];
		expect(new Set(zeroes).size).toBe(zeroes.length);
	});

	it("keeps every code in the band a verb owns for outcomes it proved", () => {
		for (const code of allocatedCodes(codes).keys()) expect(code).toBeGreaterThanOrEqual(3);
	});
});
