/** What a leaf owes its ledger — the offline half of `lane recover`. */
import {describe, expect, it} from "vitest";
import type {LaneStatus} from "./fold.ts";
import {BUILD_STATES, REVIEW_STATE, REVIEW_UI_STATE} from "./prove.ts";
import {activeTaskLeaves, owedBy, owedEvent, queuedBy, queuedPullOf} from "./recover.ts";

const status = (
	stateValue: LaneStatus["stateValue"],
	state: LaneStatus["status"] = "active",
): LaneStatus => ({stateValue, status: state, context: {}});

describe("owedEvent", () => {
	it("owes the PASS a finished reviewer alone can have posted, out of either review leaf", () => {
		expect(owedEvent(REVIEW_STATE)).toBe("PASS");
		expect(owedEvent(REVIEW_UI_STATE)).toBe("PASS");
	});

	it("owes nothing out of a leaf whose events claim no artifact", () => {
		for (const leaf of ["queued", "ship", "ship:queued", "shipped", "complete"]) {
			expect(owedEvent(leaf)).toBeNull();
		}
	});

	// A `BLOCKED` out of a review cell claims `ParkUncontradicted`, which asserts the reviewer's run
	// reached NO verdict — a negative proven by the absence of a contradiction. A sweep standing on
	// it would park every lane whose reviewer is merely still running, so no leaf ever owes one.
	it("never owes a BLOCKED, so a reviewer's park is nobody's to record unattended", () => {
		expect(Object.values({[REVIEW_STATE]: owedEvent(REVIEW_STATE)})).not.toContain("BLOCKED");
		expect(owedEvent("blocked")).toBeNull();
		expect(owedEvent("human:novel-park")).toBeNull();
	});

	// `claimOf`'s build arm claims `OpenPull`, and a PR is open for the whole of a repair round —
	// so proving it says the PR exists, never that the builder is finished with it. Owing a `DONE`
	// here would fold a lane to `review` under a builder still pushing to that same PR.
	it("never owes a DONE, because a live builder's open PR proves one too", () => {
		for (const leaf of BUILD_STATES) expect(owedEvent(leaf)).toBeNull();
	});
});

describe("activeTaskLeaves", () => {
	it("pairs each task of the active phase with its leaf", () => {
		expect(activeTaskLeaves(status({pipeline: {issue: "review"}}))).toEqual([
			{task: "issue", leaf: "review"},
		]);
	});

	it("reads every region of a parallel phase, and skips a phase still waiting", () => {
		expect(
			activeTaskLeaves(status({phase1: {task_a: "build", task_b: "review"}, phase2: "waiting"})),
		).toEqual([
			{task: "task_a", leaf: "build"},
			{task: "task_b", leaf: "review"},
		]);
	});

	it("reads no task off a folded workflow, whose stateValue is a bare terminal name", () => {
		expect(activeTaskLeaves(status("complete", "done"))).toEqual([]);
	});
});

describe("owedBy", () => {
	it("names the task, its leaf and the event that leaf owes", () => {
		expect(owedBy(status({pipeline: {issue: "review"}}))).toEqual([
			{task: "issue", leaf: "review", event: "PASS"},
		]);
	});

	it("spends nothing on a terminal lane, which owes its ledger nothing", () => {
		expect(owedBy(status("complete", "done"))).toEqual([]);
	});

	it("leaves out the active tasks whose leaf owes no provable event", () => {
		expect(
			owedBy(
				status({phase1: {task_a: "review", task_b: "blocked", task_c: "queued", task_d: "build"}}),
			),
		).toEqual([{task: "task_a", leaf: "review", event: "PASS"}]);
	});
});

describe("queuedBy and queuedPullOf", () => {
	it("finds the tasks waiting in the queue dwell, and none on a done lane", () => {
		const phase = {task_a: "ship:queued", task_b: "ship", task_c: "review"};
		expect(queuedBy(status({phase1: phase}))).toEqual([{task: "task_a", leaf: "ship:queued"}]);
		expect(queuedBy(status({phase1: phase}, "done"))).toEqual([]);
	});

	it("names the task's last PR URL, skipping other tasks and bare refs", () => {
		const url = (n: number) => `https://forge.example/o/r/pull/${n}`;
		const entries = [
			{task: "task_a", event: "TASK_A.DONE", at: "t0", pr: url(1)},
			{task: "task_a", event: "TASK_A.WIP", at: "t1", pr: url(2)},
			{task: "task_b", event: "TASK_B.WIP", at: "t2", pr: url(3)},
			{task: "task_a", event: "TASK_A.WIP", at: "t3", pr: "#4"},
		];
		expect(queuedPullOf(entries, "task_a")).toEqual({url: url(2), number: 2});
		expect(queuedPullOf(entries, "task_c")).toBeNull();
	});
});
