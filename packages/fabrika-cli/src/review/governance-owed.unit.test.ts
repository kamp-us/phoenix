import {describe, expect, it} from "vitest";
import type {CheckRun} from "../io/pulls.ts";
import type {WorkflowRun} from "../ship/github.ts";
import {governanceOwed} from "./governance-owed.ts";

const check = (name: string, status: string): CheckRun => ({
	name,
	status,
	conclusion: status === "completed" ? "success" : null,
});

const workflowRun = (name: string, status: string): WorkflowRun => ({
	id: 1,
	name,
	status,
	conclusion: status === "completed" ? "success" : null,
	completedAt: status === "completed" ? "2026-08-08T00:00:00Z" : null,
	path: `.github/workflows/${name}.yml`,
	workflowId: 1,
	checkSuiteId: 1,
});

const FLOOR = check("governance floor at head", "in_progress");
const PASSED = check("unit tests", "completed");
const FLOOR_RUN_DONE = workflowRun("governance-floor", "completed");
const CI_RUN = workflowRun("ci", "completed");

describe("governanceOwed", () => {
	it("is true when the floor is the only unfinished check and its run has completed", () => {
		expect(governanceOwed([PASSED, FLOOR], [CI_RUN, FLOOR_RUN_DONE])).toBe(true);
	});

	/** The discriminator: an in-flight run has not published yet, and that state clears itself. */
	it("is false while the floor's own workflow run is still in flight", () => {
		expect(
			governanceOwed([PASSED, FLOOR], [CI_RUN, workflowRun("governance-floor", "in_progress")]),
		).toBe(false);
	});

	it("is false when anything else is still moving — that wait has something to wait for", () => {
		expect(governanceOwed([FLOOR, check("unit tests", "queued")], [CI_RUN, FLOOR_RUN_DONE])).toBe(
			false,
		);
	});

	it("is false with no unfinished check at all — a settled head is not an owed one", () => {
		expect(governanceOwed([PASSED], [CI_RUN, FLOOR_RUN_DONE])).toBe(false);
	});

	/** No floor run at the head means the check-run came from somewhere this read cannot vouch for. */
	it("is false when no governance-floor run exists at the head", () => {
		expect(governanceOwed([PASSED, FLOOR], [CI_RUN])).toBe(false);
	});

	it("is false when one of several floor runs is still going", () => {
		expect(
			governanceOwed(
				[PASSED, FLOOR],
				[FLOOR_RUN_DONE, workflowRun("governance-floor", "in_progress")],
			),
		).toBe(false);
	});
});
