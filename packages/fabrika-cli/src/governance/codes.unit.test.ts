import {describe, expect, it} from "vitest";
import * as report from "../exit-codes.ts";
import * as review from "../review/codes.ts";
import * as triage from "../triage/codes.ts";
import * as governance from "./codes.ts";

/**
 * The table's own laws, asserted here rather than left to the alignment guard.
 *
 * The alignment guard proves the shared seats sit on the base's numbers. What it cannot prove is the
 * distinction this group's contract turns on — that "nothing was written", "a write was attempted and
 * its outcome is unknown", and "the call never decided" are three different numbers.
 */
describe("the governance exit table", () => {
	it("imports every shared seat rather than restating a numeral", () => {
		expect(governance.EMPTY_STDIN).toBe(report.EMPTY_STDIN);
		expect(governance.LEAKED_PATH).toBe(report.LEAKED_PATH);
		expect(governance.BARE_AT_PATH).toBe(report.BARE_AT_PATH);
		expect(governance.ZERO_SCOPE).toBe(report.NO_TARGET);
		expect(governance.WRITE_UNKNOWN).toBe(report.WRITE_UNKNOWN);
		expect(governance.READBACK_MISMATCH).toBe(report.READBACK_MISMATCH);
		expect(governance.PRECONDITION_UNKNOWN).toBe(report.PRECONDITION_UNKNOWN);
	});

	it("takes the off-vocabulary seat from `triage`, where this group's reading is named", () => {
		expect(governance.OFF_VOCABULARY).toBe(triage.OFF_VOCABULARY);
	});

	it("takes the two facts it proves identically from `review`", () => {
		expect(governance.STALE_HEAD).toBe(review.STALE_HEAD);
		expect(governance.INCOMPLETE_SCAN).toBe(review.INCOMPLETE_SCAN);
	});

	it("declares `14` locally — importing `review`'s would take ACL_DENIED's meaning silently", () => {
		expect(governance.NOT_HARNESS_TOUCHING).toBe(14);
		expect(review.ACL_DENIED).toBe(14);
		// Same number, different meanings, in two private bands. The test is that this group DECLARED
		// it: a re-export would make the two one binding and the wrong reading would ride along.
		expect(governance.NOT_HARNESS_TOUCHING).not.toBe(governance.OFF_VOCABULARY);
	});

	it("keeps the three unknowns apart — nothing-written, write-unproven, and the reserved failure", () => {
		const seats = [governance.PRECONDITION_UNKNOWN, governance.WRITE_UNKNOWN, 1, 127];
		expect(new Set(seats).size).toBe(seats.length);
	});

	it("holds `4` as a registered gap, not a free slot", () => {
		expect(governance.DELIBERATE_GAP).toBe(4);
		expect(governance.DELIBERATE_GAP).toBe(report.BAD_SECTIONS);
	});
});
