import {describe, expect, it} from "vitest";
import type {PipelineIssue, PipelineState} from "./pipeline.ts";
import {groupByStatus, isPickable, readFreshness, STATUS_ORDER} from "./queue.ts";

const issue = (n: number, over: Partial<PipelineIssue> = {}): PipelineIssue => ({
	number: n,
	title: `issue ${n}`,
	state: "open",
	labels: [],
	parsed: {status: null, type: null, priority: null},
	verdict: null,
	...over,
});

describe("isPickable", () => {
	it("is true only for status:triaged", () => {
		expect(isPickable(issue(1, {parsed: {status: "triaged", type: null, priority: null}}))).toBe(
			true,
		);
		for (const status of ["needs-triage", "needs-info", "planned"] as const) {
			expect(isPickable(issue(2, {parsed: {status, type: null, priority: null}}))).toBe(false);
		}
		expect(isPickable(issue(3))).toBe(false); // no status label
	});
});

describe("groupByStatus", () => {
	it("groups open issues into pipeline column order and omits empty buckets", () => {
		const groups = groupByStatus([
			issue(10, {parsed: {status: "triaged", type: null, priority: null}}),
			issue(11, {parsed: {status: "needs-triage", type: null, priority: null}}),
			issue(12, {parsed: {status: "triaged", type: null, priority: null}}),
		]);
		expect(groups.map((g) => g.status)).toEqual(["needs-triage", "triaged"]);
		expect(groups.find((g) => g.status === "triaged")?.pickable).toBe(true);
		expect(groups.find((g) => g.status === "needs-triage")?.pickable).toBe(false);
	});

	it("sorts issues by number within a group", () => {
		const groups = groupByStatus([
			issue(30, {parsed: {status: "planned", type: null, priority: null}}),
			issue(20, {parsed: {status: "planned", type: null, priority: null}}),
		]);
		expect(groups[0]?.issues.map((i) => i.number)).toEqual([20, 30]);
	});

	it("drops closed issues and files no-status issues under unlabeled", () => {
		const groups = groupByStatus([
			issue(40, {state: "closed", parsed: {status: "triaged", type: null, priority: null}}),
			issue(41),
		]);
		expect(groups.map((g) => g.status)).toEqual(["unlabeled"]);
	});

	it("never emits a status outside STATUS_ORDER", () => {
		const groups = groupByStatus([issue(50)]);
		for (const g of groups) expect(STATUS_ORDER).toContain(g.status);
	});
});

describe("readFreshness", () => {
	it("treats an absent stale field as fresh (#254 not yet landed)", () => {
		const state = {issues: [], epics: []} as PipelineState;
		expect(readFreshness(state)).toEqual({stale: false, fetchedAt: null});
	});

	it("surfaces stale + fetchedAt (epoch-ms) when the cache child provides them", () => {
		const fetchedAt = Date.parse("2026-06-14T00:00:00Z");
		const state = {
			issues: [],
			epics: [],
			stale: true,
			fetchedAt,
		} as PipelineState;
		expect(readFreshness(state)).toEqual({stale: true, fetchedAt});
	});
});
