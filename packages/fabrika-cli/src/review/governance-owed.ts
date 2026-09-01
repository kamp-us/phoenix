/**
 * The one `pending` a `--wait` must not sit through: the governance floor waiting on its own caller.
 *
 * Per ADR 0318 the `governance floor at head` check-run stays `in_progress` while no governance
 * verdict is bound at the head, so "not yet" does not read as a failure. The reviewer shell that
 * runs `review ci --wait` is the same shell that owes that verdict, so when the floor is the only
 * thing left pending nothing external will ever move it and the budget buys nothing (#7392).
 *
 * The discriminator is the workflow run, not the check-run: a floor that is `in_progress` because
 * `governance-floor.yml` has not finished publishing yet *does* clear on its own, and waiting on it
 * is correct. Only a completed floor run leaves an `in_progress` check-run that means "the verdict
 * is owed".
 */
import {FLOOR_WORKFLOW_NAME} from "../governance/floor-assert.ts";
import type {CheckRun} from "../io/pulls.ts";
import {CHECK_RUN_NAME} from "../ship/floor-check.ts";
import type {WorkflowRun} from "../ship/github.ts";

/**
 * Is every non-terminal check at this head the governance floor, with its workflow run already done?
 *
 * False whenever anything else is still moving: one other pending check means the wait has something
 * to wait for, and answering here would cut that wait short.
 */
export const governanceOwed = (
	checkRuns: ReadonlyArray<CheckRun>,
	workflowRuns: ReadonlyArray<WorkflowRun>,
): boolean => {
	const unfinished = checkRuns.filter((run) => run.status !== "completed");
	if (unfinished.length === 0) return false;
	if (!unfinished.every((run) => run.name === CHECK_RUN_NAME)) return false;
	const floorRuns = workflowRuns.filter((run) => run.name === FLOOR_WORKFLOW_NAME);
	return floorRuns.length > 0 && floorRuns.every((run) => run.status === "completed");
};
