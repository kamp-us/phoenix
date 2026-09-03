import {describe, expect, it} from "vitest";
import type {CheckRun} from "../io/pulls.ts";
import {planFor} from "../ship/floor-check.ts";
import type {FloorResolution} from "../ship/floor-verb.ts";
import type {WorkflowRun} from "../ship/github.ts";
import {governanceOwed, governanceStale, staleFloorIsTheOnlyRed} from "./governance-owed.ts";

const check = (name: string, status: string): CheckRun => ({
	name,
	status,
	conclusion: status === "completed" ? "success" : null,
	title: null,
});

/** A failing floor row wearing the title `ship floor --publish-check` writes for that state. */
const floorConcluded = (title: string | null): CheckRun => ({
	name: "governance floor at head",
	status: "completed",
	conclusion: "failure",
	title,
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

// Read off `planFor` rather than hand-copied, so a title this predicate keys on cannot drift away
// from the one `ship floor --publish-check` writes without a test here going red.
const publishedTitle = (resolution: FloorResolution): string => planFor(4321, resolution).title;
const bound = (state: string): FloorResolution => ({
	_tag: "Bound",
	state,
	sha: "03135b91",
	scanned: 3,
	stderr: [],
});
const STALE = floorConcluded(publishedTitle(bound("stale")));
const FAILED_VERDICT = floorConcluded(publishedTitle(bound("fail")));
const UNRESOLVED = floorConcluded(
	publishedTitle({_tag: "Unresolved", outcome: {code: 11, stdout: "", stderr: ["unreadable"]}}),
);
const RED_SUITE: CheckRun = {
	name: "unit tests",
	status: "completed",
	conclusion: "failure",
	title: null,
};

describe("staleFloorIsTheOnlyRed", () => {
	it("is true when the one failing check is a floor carrying a stale verdict", () => {
		expect(staleFloorIsTheOnlyRed([PASSED, STALE])).toBe(true);
	});

	/** The reader's own re-fire is still in flight; the pending row beside it changes nothing. */
	it("is true with the floor red beside a check that is merely still running", () => {
		expect(staleFloorIsTheOnlyRed([STALE, check("deploy", "in_progress")])).toBe(true);
	});

	it("is false when anything else is failing alongside the floor", () => {
		expect(staleFloorIsTheOnlyRed([STALE, RED_SUITE])).toBe(false);
	});

	it("is false when the failing check is not the floor at all", () => {
		expect(staleFloorIsTheOnlyRed([PASSED, RED_SUITE])).toBe(false);
	});

	/** UNKNOWN never passes and is nobody's to discount, least of all the shell reading it (ADR 0092). */
	it("is false on an unresolved floor", () => {
		expect(staleFloorIsTheOnlyRed([PASSED, UNRESOLVED])).toBe(false);
	});

	it("is false on a floor whose verdict is a real FAIL, which re-posting does not clear", () => {
		expect(staleFloorIsTheOnlyRed([PASSED, FAILED_VERDICT])).toBe(false);
	});

	it("is false on a title no floor of this repo wrote, and on none at all", () => {
		expect(staleFloorIsTheOnlyRed([floorConcluded("Something else entirely")])).toBe(false);
		expect(staleFloorIsTheOnlyRed([floorConcluded(null)])).toBe(false);
	});

	it("is false on a head with nothing red", () => {
		expect(staleFloorIsTheOnlyRed([PASSED, FLOOR])).toBe(false);
	});
});

describe("governanceStale", () => {
	it("is true when the stale floor is the only red and a floor run exists at the head", () => {
		expect(governanceStale([PASSED, STALE], [CI_RUN, FLOOR_RUN_DONE])).toBe(true);
	});

	/** Unlike the `absent` half, the re-fire being in flight is the very state this answers for. */
	it("is true while the floor's own workflow run is still republishing", () => {
		expect(governanceStale([PASSED, STALE], [workflowRun("governance-floor", "in_progress")])).toBe(
			true,
		);
	});

	it("is false when no governance-floor run exists at the head to vouch for the row", () => {
		expect(governanceStale([PASSED, STALE], [CI_RUN])).toBe(false);
	});

	it("is false on an unresolved floor however its run went", () => {
		expect(governanceStale([PASSED, UNRESOLVED], [CI_RUN, FLOOR_RUN_DONE])).toBe(false);
	});
});
