import {describe, expect, it} from "vitest";
import * as review from "./codes.ts";

/**
 * The review exit table's own numbers. Which of them it shares with the base registry, and that its
 * private codes clear the base's, is `../exit-code-alignment.unit.test.ts`'s to check for every
 * aligned group; what stays here is the matrix the contract states and the one duplicate check that
 * suite does not make — two meanings inside this table on one number.
 */
describe("the review exit table", () => {
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
			review.NO_GATE_COVERAGE,
			review.SUPERSEDES_VERDICT,
		]).toEqual([3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
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
			review.NO_GATE_COVERAGE,
			review.SUPERSEDES_VERDICT,
		];
		expect(new Set(allocated).size).toBe(allocated.length);
		expect(allocated).not.toContain(review.DELIBERATE_GAP);
	});
});
