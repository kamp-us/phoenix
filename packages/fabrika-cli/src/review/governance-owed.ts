/**
 * The two rollups a `review ci` caller must not read as someone else's problem: the governance floor
 * waiting on the very shell that is reading it.
 *
 * ADR 0318 splits one floor across two rollups. `absent` leaves the check-run `in_progress`, so the
 * head is `pending` and a `--wait` would sit out its whole budget ({@link governanceOwed}, #7392).
 * `stale` concludes `failure`, so the head is `red` and the verb returns at once
 * ({@link governanceStale}, #7441). Both are the same shape underneath — the reviewer shell that
 * runs `review ci` is the shell that owes the verdict, so nothing external will ever move the floor
 * — and both need the workflow run beside the check-run to be sure the row came from this repo's own
 * floor job rather than somewhere this read cannot vouch for.
 */
import {FLOOR_WORKFLOW_NAME} from "../governance/floor-assert.ts";
import type {CheckRun} from "../io/pulls.ts";
import {CHECK_RUN_NAME, publishedFloorOf} from "../ship/floor-check.ts";
import type {WorkflowRun} from "../ship/github.ts";
import {isFailing} from "./rollup.ts";

const floorRunsAt = (workflowRuns: ReadonlyArray<WorkflowRun>): ReadonlyArray<WorkflowRun> =>
	workflowRuns.filter((run) => run.name === FLOOR_WORKFLOW_NAME);

/**
 * Is every non-terminal check at this head the governance floor, with its workflow run already done?
 *
 * False whenever anything else is still moving: one other pending check means the wait has something
 * to wait for, and answering here would cut that wait short. The discriminator is the workflow run
 * rather than the check-run, because a floor that is `in_progress` only because
 * `governance-floor.yml` has not finished publishing yet *does* clear on its own.
 */
export const governanceOwed = (
	checkRuns: ReadonlyArray<CheckRun>,
	workflowRuns: ReadonlyArray<WorkflowRun>,
): boolean => {
	const unfinished = checkRuns.filter((run) => run.status !== "completed");
	if (unfinished.length === 0) return false;
	if (!unfinished.every((run) => run.name === CHECK_RUN_NAME)) return false;
	const floorRuns = floorRunsAt(workflowRuns);
	return floorRuns.length > 0 && floorRuns.every((run) => run.status === "completed");
};

/**
 * Is a stale governance floor the only thing red at this head? The cheap half of
 * {@link governanceStale}, over the check-runs a caller has already enumerated.
 *
 * Its own export because it is the gate on whether to pay for the workflow-run read at all: a red
 * carrying a failing test suite has an answer already, and asking the platform which gates ran there
 * buys nothing. Forgetting to call it therefore costs a request and never a wrong answer —
 * {@link governanceStale} asserts it again.
 *
 * `stale` alone, off the floor's published title: `fail` is a real governance FAIL the caller cannot
 * clear by re-posting, and `unresolved` is UNKNOWN, which never passes and is nobody's to discount
 * (ADR 0092). A title this repo's floor did not write is `Unreadable` and falls through with them.
 */
export const staleFloorIsTheOnlyRed = (checkRuns: ReadonlyArray<CheckRun>): boolean => {
	const failing = checkRuns.filter(isFailing);
	if (failing.length !== 1) return false;
	const floor = failing[0];
	if (floor === undefined || floor.name !== CHECK_RUN_NAME) return false;
	const published = publishedFloorOf(floor.title);
	return published._tag === "Blocked" && published.state === "stale";
};

/**
 * Is this head's `red` a stale governance floor and nothing else — a red its own reader clears?
 *
 * The floor run at the head is required but its status is not: unlike the `absent` half, an
 * in-flight floor run here is the caller's own re-fire still republishing, which is the second read
 * #7441 recorded. What the run proves is provenance — with no floor run at this head the failing
 * check-run came from somewhere this read cannot vouch for, so it stays a plain red.
 */
export const governanceStale = (
	checkRuns: ReadonlyArray<CheckRun>,
	workflowRuns: ReadonlyArray<WorkflowRun>,
): boolean => staleFloorIsTheOnlyRed(checkRuns) && floorRunsAt(workflowRuns).length > 0;
