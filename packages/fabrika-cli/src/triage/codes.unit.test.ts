import {describe, expect, it} from "vitest";
import {checkAlignment, SHARED_SEATS} from "../exit-code-alignment.ts";
import * as report from "../exit-codes.ts";
import * as codes from "./codes.ts";
import {
	BARE_AT_PATH,
	CLAIM_NOT_HELD,
	CLAIMED_ELSEWHERE,
	CRITERIA_REQUIRED,
	DELIBERATE_GAP,
	EMPTY_STDIN,
	HUMAN_FILED,
	LEAKED_PATH,
	MALFORMED_CRITERIA,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TRIAGE_EXIT_TABLE,
	UNCONFIRMED,
	UNREPAIRABLE,
	UNWIRED_ORDERING,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";

/**
 * The alignment is asserted against the shipped `report` constants, not against copied literals — a
 * test over `expect(LEAKED_PATH).toBe(5)` would stay green while the two tables drifted apart, which
 * is the only failure this alignment exists to prevent.
 */
describe("the overlap with `report`'s writing verbs is code-for-code", () => {
	it.each([
		["EMPTY_STDIN", EMPTY_STDIN, report.EMPTY_STDIN],
		["LEAKED_PATH", LEAKED_PATH, report.LEAKED_PATH],
		["BARE_AT_PATH", BARE_AT_PATH, report.BARE_AT_PATH],
		["ZERO_SCOPE / NO_TARGET", ZERO_SCOPE, report.NO_TARGET],
		["WRITE_UNKNOWN", WRITE_UNKNOWN, report.WRITE_UNKNOWN],
		["READBACK_MISMATCH", READBACK_MISMATCH, report.READBACK_MISMATCH],
		["OFF_VOCABULARY / CLASSIFIED", OFF_VOCABULARY, report.CLASSIFIED],
		["PRECONDITION_UNKNOWN", PRECONDITION_UNKNOWN, report.PRECONDITION_UNKNOWN],
	])("`%s` sits on the same number in both groups", (_name, triage, shipped) => {
		expect(triage).toBe(shipped);
	});
});

describe("the codes this group adds", () => {
	it("seats the human-filed refusal clear of `report`'s shipped 11", () => {
		expect(HUMAN_FILED).toBe(12);
		expect(HUMAN_FILED).not.toBe(report.PRECONDITION_UNKNOWN);
	});

	it("seats the unconfirmed-kill refusal on its own code", () => {
		expect(UNCONFIRMED).toBe(13);
		expect(UNCONFIRMED).not.toBe(HUMAN_FILED);
	});

	it("seats the unrepairable-drift refusal on its own code", () => {
		expect(UNREPAIRABLE).toBe(14);
		expect(UNREPAIRABLE).not.toBe(UNCONFIRMED);
	});

	/**
	 * Two criteria refusals, two codes, and the distinctness is the point: `repair-criteria` answers
	 * `14` about a block already on the board, `enrich` answers `15` about one that has not landed.
	 * Fusing them would tell a caller to hand-edit an issue it has not written yet.
	 */
	it("seats the malformed-criteria refusal clear of the unrepairable one", () => {
		expect(MALFORMED_CRITERIA).toBe(15);
		expect(MALFORMED_CRITERIA).not.toBe(UNREPAIRABLE);
	});

	/**
	 * A third criteria code, and the split is the same one: `15` is about a block `enrich` composed
	 * and has not written, where `Absent` is allowed; `16` is about a body already on the board that
	 * `--ready-for agent` is being stamped over, where `Absent` is the refusal.
	 */
	it("seats the criteria-required refusal clear of the malformed-criteria one", () => {
		expect(CRITERIA_REQUIRED).toBe(16);
		expect(CRITERIA_REQUIRED).not.toBe(MALFORMED_CRITERIA);
	});

	/**
	 * The pairwise checks above name one `report` constant each, so a *new* code added upstream at
	 * `12` or `13` would land on top of this group and every one of them would stay green. This reads
	 * the base's occupied seats off its exports instead, which is the only form that covers a code
	 * nobody has written yet (#4924).
	 */
	/**
	 * `17` is *a live marker names another session* and deliberately passes a caller holding none;
	 * `19` is *this lane holds none*, which only the scratch allocator may refuse on. Fusing them
	 * would either make an unclaimed issue unmutable or hand a claimless lane a namespace.
	 */
	it("seats the claim-not-held refusal clear of the claimed-elsewhere one", () => {
		expect(CLAIM_NOT_HELD).toBe(19);
		expect(CLAIM_NOT_HELD).not.toBe(CLAIMED_ELSEWHERE);
	});

	/**
	 * `15` is the *shape* of a block in the body a re-send can correct; `20` is the body disagreeing
	 * with the *graph*, which no re-send alone can fix. Fusing them would send a caller looking for a
	 * markdown defect that is not there.
	 */
	it("seats the unwired-ordering refusal clear of the malformed-criteria one", () => {
		expect(UNWIRED_ORDERING).toBe(20);
		expect(UNWIRED_ORDERING).not.toBe(MALFORMED_CRITERIA);
		expect(UNWIRED_ORDERING).not.toBe(CLAIM_NOT_HELD);
	});

	it("clears every seat `report` occupies, read from its exports and not a list", () => {
		expect(checkAlignment(report, codes, SHARED_SEATS).collisions).toEqual([]);
	});
});

describe("TRIAGE_EXIT_TABLE", () => {
	const codes = TRIAGE_EXIT_TABLE.map((row) => row.code);

	it("leaves 4 unallocated — a gap is cheaper than a collision", () => {
		expect(DELIBERATE_GAP).toBe(4);
		expect(codes).not.toContain(DELIBERATE_GAP);
	});

	it("carries every allocated code exactly once", () => {
		expect(codes).toEqual([
			0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 126, 127,
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
	});
});
