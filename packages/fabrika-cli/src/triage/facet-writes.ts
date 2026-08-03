/**
 * Issue a reconcile plan's changes in order, counting how many landed before one failed.
 *
 * The count is the point. Exit `8` reports "write failed after `<k>` of `<m>` changes", and a caller
 * told only that *something* failed cannot tell an issue that was never touched from one left half
 * labelled — so the changes are decomposed into individually-observable add/remove calls rather than
 * collapsed into a single replace-set `PUT`, and the applier reports the index it stopped at.
 *
 * The adds go through `POST .../labels`, which **creates an unknown label rather than rejecting it**
 * — so the caller's vocabulary precondition is not optional politeness, it is the only thing between
 * a typo and a repo-wide grey label (#4285).
 */
import {Effect} from "effect";
import type {Attempt, Shell} from "../io/git.ts";
import {addLabels, clearMilestone, removeLabel, setMilestone} from "../io/issues.ts";
import type {Change} from "./facets.ts";

export type WriteOutcome =
	| {readonly _tag: "Applied"; readonly count: number}
	| {readonly _tag: "Failed"; readonly applied: number; readonly reason: string};

const runChange = (repo: string, issue: number, change: Change): Shell<Attempt<unknown>> => {
	switch (change._tag) {
		case "SetMilestone":
			return setMilestone(repo, issue, change.milestone);
		case "ClearMilestone":
			return clearMilestone(repo, issue);
		case "RemoveLabel":
			return removeLabel(repo, issue, change.label);
		case "AddLabels":
			return addLabels(repo, issue, change.labels);
	}
};

export const applyChanges = (
	repo: string,
	issue: number,
	changes: ReadonlyArray<Change>,
): Shell<WriteOutcome> =>
	Effect.gen(function* () {
		let applied = 0;
		for (const change of changes) {
			const result = yield* runChange(repo, issue, change);
			if (result._tag === "Failure")
				return {_tag: "Failed" as const, applied, reason: result.reason};
			applied += 1;
		}
		return {_tag: "Applied" as const, count: applied};
	});
