import {describe, expect, it} from "vitest";
import {
	CHUNK_MISCOUNTED,
	CLAIM_NOT_HELD,
	CLAIMED_ELSEWHERE,
	CRITERIA_REQUIRED,
	DELIBERATE_GAP,
	DUPLICATE_VERDICT,
	HUMAN_FILED,
	MALFORMED_AUDIT,
	MALFORMED_CRITERIA,
	PLAIN_SUMMARY_REQUIRED,
	PRECONDITION_UNKNOWN,
	PULL_REQUEST_TARGET,
	SET_MISMATCH,
	TRIAGE_EXIT_TABLE,
	UNCONFIRMED,
	UNHOMED_REMAIN,
	UNREPAIRABLE,
	UNWIRED_ORDERING,
	ZERO_SCOPE,
} from "./codes.ts";

/**
 * The table is built from the exported constants, so the ordered code list below pins every
 * constant's number at once: a re-seated or doubled code reorders or repeats it. Which seats this
 * group shares with the base registry, and that its private codes clear the base's, is
 * `../exit-code-alignment.unit.test.ts`'s to check for every aligned group.
 */
describe("TRIAGE_EXIT_TABLE", () => {
	const codes = TRIAGE_EXIT_TABLE.map((row) => row.code);

	it("leaves 4 unallocated — a gap is cheaper than a collision", () => {
		expect(DELIBERATE_GAP).toBe(4);
		expect(codes).not.toContain(DELIBERATE_GAP);
	});

	it("carries every allocated code exactly once", () => {
		expect(codes).toEqual([
			0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
			27, 126, 127,
		]);
	});

	it("gives every code a non-empty meaning", () => {
		for (const row of TRIAGE_EXIT_TABLE) expect(row.meaning.length).toBeGreaterThan(0);
	});

	it("states each exported constant's meaning at its own number", () => {
		const meaningOf = (code: number) => TRIAGE_EXIT_TABLE.find((row) => row.code === code)?.meaning;
		expect(meaningOf(ZERO_SCOPE)).toContain("proven absent");
		expect(meaningOf(PRECONDITION_UNKNOWN)).toContain("precondition read failed");
		expect(meaningOf(HUMAN_FILED)).toContain("human-filed");
		expect(meaningOf(UNCONFIRMED)).toContain("unconfirmed");
		expect(meaningOf(UNREPAIRABLE)).toContain("not mechanically repairable");
		expect(meaningOf(MALFORMED_CRITERIA)).toContain("acceptance-criteria");
		expect(meaningOf(CRITERIA_REQUIRED)).toContain("--ready-for agent");
		expect(meaningOf(CLAIMED_ELSEWHERE)).toContain("another session");
		expect(meaningOf(CLAIM_NOT_HELD)).toContain("holds no live claim");
		expect(meaningOf(UNWIRED_ORDERING)).toContain("blocked_by");
		expect(meaningOf(PULL_REQUEST_TARGET)).toContain("pull request");
		expect(meaningOf(MALFORMED_AUDIT)).toContain("verdict row");
		expect(meaningOf(CHUNK_MISCOUNTED)).toContain("declared");
		expect(meaningOf(DUPLICATE_VERDICT)).toContain("more than one verdict row");
		expect(meaningOf(SET_MISMATCH)).toContain("audited input set");
		expect(meaningOf(PLAIN_SUMMARY_REQUIRED)).toContain("plain-language summary");
		expect(meaningOf(UNHOMED_REMAIN)).toContain("un-homed");
	});
});
