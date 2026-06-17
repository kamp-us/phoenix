import {describe, expect, it} from "vitest";
import {groupByMilestone, milestonePercent} from "./milestone.ts";
import type {PipelineIssue, PipelineMilestone, PipelineState} from "./pipeline.ts";

const milestone = (over: Partial<PipelineMilestone> = {}): PipelineMilestone => ({
	number: 1,
	title: "Pipeline hardening",
	state: "open",
	openIssues: 14,
	closedIssues: 7,
	...over,
});

const issue = (n: number, milestone: PipelineMilestone | null): PipelineIssue => ({
	number: n,
	title: `issue ${n}`,
	state: "open",
	labels: [],
	parsed: {status: null, type: null, priority: null},
	verdict: null,
	milestone,
});

const state = (issues: PipelineIssue[]): PipelineState => ({issues, epics: []});

describe("groupByMilestone", () => {
	it("groups issues under their milestone and omits unassigned ones", () => {
		const m1 = milestone({number: 1});
		const m2 = milestone({number: 2, title: "Distribution"});
		const groups = groupByMilestone(
			state([issue(10, m1), issue(11, m2), issue(12, null), issue(13, m1)]),
		);
		expect(groups.map((g) => g.number)).toEqual([1, 2]);
		expect(groups.find((g) => g.number === 1)?.issues.map((i) => i.number)).toEqual([10, 13]);
		expect(groups.find((g) => g.number === 2)?.issues.map((i) => i.number)).toEqual([11]);
	});

	it("sorts open milestones first, then closed, each by ascending number", () => {
		const groups = groupByMilestone(
			state([
				issue(1, milestone({number: 5, state: "closed"})),
				issue(2, milestone({number: 3, state: "open"})),
				issue(3, milestone({number: 1, state: "closed"})),
				issue(4, milestone({number: 2, state: "open"})),
			]),
		);
		expect(groups.map((g) => g.number)).toEqual([2, 3, 1, 5]);
	});

	it("carries GitHub's rollup counts, not the fetched member count", () => {
		// One fetched member, but the milestone's rollup says 7 closed / 14 open.
		const groups = groupByMilestone(
			state([issue(10, milestone({openIssues: 14, closedIssues: 7}))]),
		);
		const g = groups[0];
		expect(g?.issues.length).toBe(1);
		expect(g?.openIssues).toBe(14);
		expect(g?.closedIssues).toBe(7);
		expect(g?.total).toBe(21);
		expect(g?.fraction).toBeCloseTo(7 / 21);
	});

	it("yields a 0% fraction for an empty milestone, never NaN", () => {
		const groups = groupByMilestone(
			state([issue(10, milestone({openIssues: 0, closedIssues: 0}))]),
		);
		expect(groups[0]?.fraction).toBe(0);
		expect(milestonePercent(groups[0]!)).toBe(0);
	});

	it("sorts the fetched issues within a group by number ascending", () => {
		const m = milestone();
		const groups = groupByMilestone(state([issue(30, m), issue(20, m), issue(25, m)]));
		expect(groups[0]?.issues.map((i) => i.number)).toEqual([20, 25, 30]);
	});
});

describe("milestonePercent", () => {
	it("rounds the closed fraction to a whole percent", () => {
		const groups = groupByMilestone(state([issue(1, milestone({openIssues: 2, closedIssues: 1}))]));
		expect(milestonePercent(groups[0]!)).toBe(33);
	});
});
