import {describe, expect, it} from "vitest";
import {PRESENT} from "../vocabulary-preflight/presence.ts";
import {type ArmingInput, BANKED_LABEL, judge, renderReport} from "./cp-bank.ts";

const NOW = "2026-08-02T18:10:00Z";
const PR_4742 = {number: 4742, title: "fix(ship-it): merge authorization"};

const input = (over: Partial<ArmingInput>): ArmingInput => ({
	vocabulary: PRESENT,
	banked: [PR_4742],
	liveness: {_tag: "ticked", lastAt: "2026-08-02T18:00:00Z"},
	now: NOW,
	windowHours: 2,
	...over,
});

/**
 * The #4754 regression: before this tool, a §CP PR banked WITH an armed watcher and one banked
 * WITHOUT were the same observation from outside. These two cases are that pair, and they must
 * not agree.
 */
describe("bank-with-arm vs bank-without-arm are no longer the same state", () => {
	const bankWithArm = judge(input({}));
	const bankWithoutArm = judge(input({liveness: {_tag: "no-record"}}));

	it("bank-with-arm is green", () => {
		expect(bankWithArm._tag).toBe("green");
	});

	it("bank-without-arm is red", () => {
		expect(bankWithoutArm._tag).toBe("red");
	});

	it("the two verdicts differ — the identity in the incident is broken", () => {
		expect(bankWithoutArm._tag).not.toBe(bankWithArm._tag);
		expect(renderReport(bankWithoutArm)).not.toBe(renderReport(bankWithArm));
	});

	it("the red names the stranded PR, so the report is actionable", () => {
		expect(renderReport(bankWithoutArm)).toContain("#4742");
	});
});

describe("staleness is measured against the window, not against 'a tick exists'", () => {
	it("a tick inside the window is green", () => {
		expect(judge(input({liveness: {_tag: "ticked", lastAt: "2026-08-02T16:30:00Z"}}))._tag).toBe(
			"green",
		);
	});

	it("a tick older than the window is red — the 8h34m strand", () => {
		const verdict = judge(input({liveness: {_tag: "ticked", lastAt: "2026-08-02T09:36:00Z"}}));
		expect(verdict._tag).toBe("red");
		expect(renderReport(verdict)).toContain("8.6h old");
	});

	it("a tick exactly at the window boundary is still green", () => {
		expect(judge(input({liveness: {_tag: "ticked", lastAt: "2026-08-02T16:10:00Z"}}))._tag).toBe(
			"green",
		);
	});
});

describe("an empty banked set is a green, and only when it was PROVEN empty", () => {
	it("nothing banked and no tick ever is green — nothing is owed a tick", () => {
		expect(judge(input({banked: [], liveness: {_tag: "no-record"}}))._tag).toBe("green");
	});

	it("an absent scoping label is UNKNOWN, never the empty set it would derive", () => {
		const verdict = judge(
			input({banked: [], vocabulary: {_tag: "absent", missing: [BANKED_LABEL]}}),
		);
		expect(verdict._tag).toBe("unknown");
		expect(renderReport(verdict)).toContain(BANKED_LABEL);
	});

	it("an absent label is UNKNOWN even when the board read returned banked PRs", () => {
		expect(judge(input({vocabulary: {_tag: "absent", missing: [BANKED_LABEL]}}))._tag).toBe(
			"unknown",
		);
	});
});

describe("an unreadable input never resolves to a verdict", () => {
	it("an unparseable tick instant is UNKNOWN, not a stale-tick red", () => {
		expect(judge(input({liveness: {_tag: "ticked", lastAt: "whenever"}}))._tag).toBe("unknown");
	});

	it("an unparseable now is UNKNOWN", () => {
		expect(judge(input({now: ""}))._tag).toBe("unknown");
	});

	it("a non-positive window is UNKNOWN, not an instantly-red gate", () => {
		expect(judge(input({windowHours: 0}))._tag).toBe("unknown");
	});
});
