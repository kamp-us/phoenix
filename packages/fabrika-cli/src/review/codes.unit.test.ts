import {describe, expect, it} from "vitest";
import * as report from "../report/codes.ts";
import * as triage from "../triage/codes.ts";
import * as review from "./codes.ts";

/**
 * The parity assertion the acceptance criterion names: where this group's codes overlap the shipped
 * writing verbs', they match **code for code**, read from the shipped package and never from a
 * contract.md (#4752).
 *
 * The test is not redundant with the re-export in `./codes.ts`. It pins the *claim* — that these
 * particular meanings are the ones aligned — so a future edit that swaps a re-export for a numeral
 * reds here instead of drifting silently.
 */
describe("the review exit table", () => {
	it("matches report's writing codes, code for code", () => {
		expect(review.EMPTY_STDIN).toBe(report.EMPTY_STDIN);
		expect(review.LEAKED_PATH).toBe(report.LEAKED_PATH);
		expect(review.BARE_AT_PATH).toBe(report.BARE_AT_PATH);
		expect(review.ZERO_SCOPE).toBe(report.NO_TARGET);
		expect(review.WRITE_UNKNOWN).toBe(report.WRITE_UNKNOWN);
		expect(review.READBACK_MISMATCH).toBe(report.READBACK_MISMATCH);
		expect(review.PRECONDITION_UNKNOWN).toBe(report.PRECONDITION_UNKNOWN);
	});

	it("matches triage's overlapping codes too, so one sweep reads one meaning", () => {
		expect(review.EMPTY_STDIN).toBe(triage.EMPTY_STDIN);
		expect(review.LEAKED_PATH).toBe(triage.LEAKED_PATH);
		expect(review.BARE_AT_PATH).toBe(triage.BARE_AT_PATH);
		expect(review.ZERO_SCOPE).toBe(triage.ZERO_SCOPE);
		expect(review.WRITE_UNKNOWN).toBe(triage.WRITE_UNKNOWN);
		expect(review.READBACK_MISMATCH).toBe(triage.READBACK_MISMATCH);
		expect(review.OFF_VOCABULARY).toBe(triage.OFF_VOCABULARY);
		expect(review.PRECONDITION_UNKNOWN).toBe(triage.PRECONDITION_UNKNOWN);
	});

	it("seats the contract's matrix on the numbers it states", () => {
		expect([
			review.EMPTY_STDIN,
			review.LEAKED_PATH,
			review.BARE_AT_PATH,
			review.ZERO_SCOPE,
			review.WRITE_UNKNOWN,
			review.READBACK_MISMATCH,
			review.OFF_VOCABULARY,
			review.PRECONDITION_UNKNOWN,
			review.STALE_HEAD,
			review.INCOMPLETE_SCAN,
			review.ACL_DENIED,
			review.APPEND_ONLY,
		]).toEqual([3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
	});

	it("leaves 4 a gap, and collides no two meanings on one code", () => {
		expect(review.DELIBERATE_GAP).toBe(4);
		const allocated = [
			review.EMPTY_STDIN,
			review.LEAKED_PATH,
			review.BARE_AT_PATH,
			review.ZERO_SCOPE,
			review.WRITE_UNKNOWN,
			review.READBACK_MISMATCH,
			review.OFF_VOCABULARY,
			review.PRECONDITION_UNKNOWN,
			review.STALE_HEAD,
			review.INCOMPLETE_SCAN,
			review.ACL_DENIED,
			review.APPEND_ONLY,
		];
		expect(new Set(allocated).size).toBe(allocated.length);
		expect(allocated).not.toContain(review.DELIBERATE_GAP);
	});
});
