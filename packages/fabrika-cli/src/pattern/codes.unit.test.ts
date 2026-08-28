import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {allocatedCodes, verbLocalCodesIn} from "../exit-code-alignment.ts";
import * as report from "../exit-codes.ts";
import * as codes from "./codes.ts";

const GROUP_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("the `pattern` group allocates from one table", () => {
	// `adr` shipped a `NO_SUBJECT` in two verb files on two numbers (#5294). An imported and a
	// declared export are indistinguishable once a module is loaded, so this reads the source.
	it("leaves no verb module seating a code of its own", () => {
		expect(verbLocalCodesIn(GROUP_DIR)).toEqual([]);
	});

	it("finds codes at all, so no assertion below passes over an empty table (ADR 0092)", () => {
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
 * unable to write its first pattern doc on the documented path (#5254).
 */
describe("the deliberate gaps stay gaps", () => {
	it("seats nothing on 3 through 7", () => {
		for (const code of [3, 4, 5, 6, 7]) expect(allocatedCodes(codes).has(code)).toBe(false);
	});

	it("in particular never seats 7, the zero-scope refusal", () => {
		expect(Object.values(codes)).not.toContain(7);
	});
});

/**
 * The four shared seats, verified as **the base's own values** rather than as numerals. The import
 * is what makes a drift unrepresentable; this asserts the claim the import is making.
 */
describe("the shared seats are the base's", () => {
	it("carries the base's number for each meaning it shares", () => {
		expect(codes.WRITE_UNKNOWN).toBe(report.WRITE_UNKNOWN);
		expect(codes.READBACK_MISMATCH).toBe(report.READBACK_MISMATCH);
		expect(codes.OFF_VOCABULARY).toBe(report.CLASSIFIED);
		expect(codes.PRECONDITION_UNKNOWN).toBe(report.PRECONDITION_UNKNOWN);
	});

	it("clears the base's whole table with every code it adds on its own account", () => {
		const occupied = allocatedCodes(report);
		for (const code of [
			codes.DOC_ABSENT,
			codes.ALREADY_EXISTS,
			codes.MULTI_LINE_DIFF,
			codes.INDEX_UNPARSEABLE,
			codes.SECTION_AMBIGUOUS,
			codes.SOURCE_REPOSITORY_REFUSED,
		]) {
			expect(occupied.has(code)).toBe(false);
		}
	});
});
