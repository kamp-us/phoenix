import {describe, expect, it} from "vitest";
import type {ShipCheckRun, WorkflowRun} from "./github.ts";
import {isSuperseded, supersededSuites} from "./supersession.ts";

const workflowRun = (shape: {
	id: number;
	workflowId: number;
	suite?: number | null;
	conclusion?: string | null;
}): WorkflowRun => ({
	id: shape.id,
	name: "CI",
	status: shape.conclusion == null ? "in_progress" : "completed",
	conclusion: shape.conclusion ?? null,
	completedAt: null,
	path: ".github/workflows/ci.yml",
	workflowId: shape.workflowId,
	checkSuiteId: shape.suite === undefined ? shape.id : shape.suite,
});

const checkRun = (conclusion: string, checkSuiteId: number): ShipCheckRun => ({
	name: "ci-required",
	status: "completed",
	conclusion,
	startedAt: "2026-08-08T00:00:00Z",
	id: 1,
	checkSuiteId,
});

describe("supersededSuites", () => {
	it("names the suite of every run a later run of the same workflow replaced", () => {
		const suites = supersededSuites([
			workflowRun({id: 11, workflowId: 7, conclusion: "cancelled"}),
			workflowRun({id: 12, workflowId: 7}),
		]);
		expect([...suites]).toEqual([11]);
	});

	it("leaves the newest run of a workflow alone, however many preceded it", () => {
		const suites = supersededSuites([
			workflowRun({id: 11, workflowId: 7, conclusion: "cancelled"}),
			workflowRun({id: 12, workflowId: 7, conclusion: "cancelled"}),
			workflowRun({id: 13, workflowId: 7}),
		]);
		expect([...suites].sort()).toEqual([11, 12]);
	});

	it("never crosses workflows — a newer run of a different workflow supersedes nothing", () => {
		const suites = supersededSuites([
			workflowRun({id: 11, workflowId: 7, conclusion: "cancelled"}),
			workflowRun({id: 12, workflowId: 8}),
		]);
		expect([...suites]).toEqual([]);
	});

	it("skips a run naming no suite — there is nothing to join a check context to", () => {
		const suites = supersededSuites([
			workflowRun({id: 11, workflowId: 7, suite: null, conclusion: "cancelled"}),
			workflowRun({id: 12, workflowId: 7}),
		]);
		expect([...suites]).toEqual([]);
	});
});

describe("isSuperseded", () => {
	it("holds only for a cancelled run published by a superseded suite", () => {
		const suites = new Set([91]);
		expect(isSuperseded(checkRun("cancelled", 91), suites)).toBe(true);
		expect(isSuperseded(checkRun("cancelled", 92), suites)).toBe(false);
		expect(isSuperseded(checkRun("failure", 91), suites)).toBe(false);
	});
});
