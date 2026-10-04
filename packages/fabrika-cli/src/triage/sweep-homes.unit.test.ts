import {describe, expect, it} from "vitest";
import type {TriagedIssue} from "../guard/homing.ts";
import {
	type DoubleMarked,
	hasTrail,
	landedExempt,
	planSweep,
	stillDoubleMarked,
	trailComment,
	trailMarker,
} from "./sweep-homes.ts";

const issue = (
	number: number,
	milestone: number | null,
	...lanes: ReadonlyArray<string>
): TriagedIssue => ({
	number,
	title: `issue ${number}`,
	milestone,
	labels: ["status:triaged", ...lanes],
});

const LANE = "axis:pipeline-hardening";

describe("planSweep", () => {
	it("plans a clear for each double-marked issue and lists each un-homed one untouched", () => {
		const plan = planSweep([
			issue(1, 17),
			issue(2, null, LANE),
			issue(3, 17, LANE),
			issue(4, null),
			issue(5, 9, "wayfinder:backlog"),
		]);
		expect(plan).toEqual({
			_tag: "Planned",
			scanned: 5,
			homed: 1,
			exempt: 1,
			clears: [
				{kind: "double-marked", number: 3, title: "issue 3", milestone: 17, lanes: [LANE]},
				{
					kind: "double-marked",
					number: 5,
					title: "issue 5",
					milestone: 9,
					lanes: ["wayfinder:backlog"],
				},
			],
			unhomed: [{kind: "unhomed", number: 4, title: "issue 4"}],
		});
	});

	/**
	 * The idempotence claim: the board a completed apply leaves behind — each double-marked issue now
	 * milestone-less with its lane — plans zero clears, so a second run writes nothing.
	 */
	it("plans no clear over the board a completed sweep leaves behind", () => {
		const before = [issue(1, 17), issue(3, 17, LANE)];
		const first = planSweep(before);
		expect(first._tag === "Planned" && first.clears.length).toBe(1);
		const after = [issue(1, 17), issue(3, null, LANE)];
		expect(planSweep(after)).toEqual({
			_tag: "Planned",
			scanned: 2,
			homed: 1,
			exempt: 1,
			clears: [],
			unhomed: [],
		});
	});
});

const BREACH: DoubleMarked = {
	kind: "double-marked",
	number: 3,
	title: "issue 3",
	milestone: 17,
	lanes: [LANE],
};

describe("the per-issue checks", () => {
	it("keeps a breach that still stands and drops one that moved", () => {
		expect(stillDoubleMarked(issue(3, 17, LANE), BREACH)).toBe(true);
		expect(stillDoubleMarked(issue(3, null, LANE), BREACH)).toBe(false);
		expect(stillDoubleMarked(issue(3, 18, LANE), BREACH)).toBe(false);
		expect(stillDoubleMarked(issue(3, 17), BREACH)).toBe(false);
	});

	it("reads a clear as landed only when the milestone is gone and the lane is kept", () => {
		expect(landedExempt(issue(3, null, LANE), BREACH)).toBe(true);
		expect(landedExempt(issue(3, 17, LANE), BREACH)).toBe(false);
		expect(landedExempt(issue(3, null), BREACH)).toBe(false);
	});
});

describe("the trail comment", () => {
	it("states the clear, carries the caller's citation, and ends on the milestone's marker", () => {
		const body = trailComment(BREACH, "Per the homing decision.\n");
		expect(body).toContain("milestone 17");
		expect(body).toContain(`\`${LANE}\``);
		expect(body).toContain("Per the homing decision.");
		expect(body.endsWith(trailMarker(17))).toBe(true);
	});

	it("finds an earlier trail by its marker, so a re-run posts no second one", () => {
		const posted = trailComment(BREACH, "cite");
		expect(hasTrail(["unrelated", posted], 17)).toBe(true);
		expect(hasTrail(["unrelated"], 17)).toBe(false);
		expect(hasTrail([posted], 18)).toBe(false);
	});
});
