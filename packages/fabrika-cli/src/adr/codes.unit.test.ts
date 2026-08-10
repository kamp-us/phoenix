import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {allocatedCodes, verbLocalCodesIn} from "../exit-code-alignment.ts";
import * as codes from "./codes.ts";

const GROUP_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * The defect this group shipped, pinned from both ends (#5294): a verb that seats its own numeral,
 * and a number that carries more than one meaning. Run against the pre-fix verb modules the first
 * assertion reports fifteen declarations across five files — including `NO_SUBJECT` twice, on two
 * numbers.
 */
describe("the `adr` group allocates from one table", () => {
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

	it("keeps every code in the band a verb owns for outcomes it proved", () => {
		for (const code of allocatedCodes(codes).keys()) expect(code).toBeGreaterThanOrEqual(3);
	});

	it("leaves `5` vacated — it named a refusal this group no longer makes (#5254, #5297)", () => {
		expect(allocatedCodes(codes).has(5)).toBe(false);
	});
});
