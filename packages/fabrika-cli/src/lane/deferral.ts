/**
 * A deferral — the authorized plan change that takes one non-landed child out of a running epic's
 * plan while its issue stays open, and while every line it recorded stays in the log.
 *
 * `lane amend` refuses to drop a task carrying history, because a dropped task's recorded lines
 * would then be lines the ledger no longer accounts for. That refusal is right for the case it was
 * written for and wrong for a descope: a child the founder cancelled cannot "reach a leaf the
 * amendment can carry", and re-emitting the lane is the destructive route the amendment replaced.
 * So the drop is admitted only when the amendment **names** it — which task, and how much of that
 * task's history the naming covers — and the naming rides the same {@link AMENDED_EVENT} line the
 * amendment already appends, under its own `defers` payload.
 *
 * The bound is what keeps the account honest. `through` names the `at` of the task's last recorded
 * entry, so a reader folding the log later can prove the deferral covered everything the task ever
 * said rather than an opening slice of it, and a line recorded for that task afterwards is a
 * reintroduction the fold refuses instead of silently ignoring. Nothing here reads disk or the
 * board: entries in, verdict out.
 *
 */
import type {LogEntry} from "./fold.ts";
import {AMENDED_EVENT, bareEvent} from "./machine.ts";

/** One task an amendment defers, as it rides the `defers` payload. */
export interface Deferral {
	/** The task id leaving the plan — `issue_<n>` for an epic child. */
	readonly task: string;
	/** The `at` of that task's last recorded entry: the bound this deferral covers. */
	readonly through: string;
	/** Why the plan changed, journaled verbatim. */
	readonly reason: string;
}

/** A resolved deferral, carrying the `at` of the amendment line that recorded it. */
export interface ResolvedDeferral extends Deferral {
	/** The `at` of the {@link AMENDED_EVENT} line carrying this deferral. */
	readonly at: string;
}

export type DeferralResult =
	| {readonly _tag: "Resolved"; readonly deferrals: ReadonlyArray<ResolvedDeferral>}
	| {readonly _tag: "Undecidable"; readonly defects: ReadonlyArray<string>};

/**
 * Resolve every `defers` payload in the log against the entries it claims to cover.
 *
 * Four things make a deferral undecidable, and each is a defect rather than a resolution — picking
 * one reading over the other would invent a history:
 *
 * - `through` names no entry of that task, so the bound stands over nothing;
 * - `through` names more than one, so which line bounds it is unreadable;
 * - the task recorded an entry the bound does not cover — either later in the log than the bound, or
 *   after the amendment line itself, which is a child quietly reintroduced into a plan that dropped
 *   it;
 * - the same task is deferred twice, which is one plan change applied two ways.
 */
export const resolveDeferrals = (entries: ReadonlyArray<LogEntry>): DeferralResult => {
	const defects: string[] = [];
	const deferrals: ResolvedDeferral[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (bareEvent(entry.event) !== AMENDED_EVENT) continue;
		for (const deferral of entry.defers ?? []) {
			if (seen.has(deferral.task)) {
				defects.push(
					`the ${AMENDED_EVENT} at ${entry.at} defers task "${deferral.task}", which an earlier amendment already deferred`,
				);
				continue;
			}
			seen.add(deferral.task);
			const recorded = entries
				.map((candidate, at) => ({candidate, at}))
				.filter(
					({candidate}) =>
						candidate.task === deferral.task && bareEvent(candidate.event) !== AMENDED_EVENT,
				);
			const bounded = recorded.filter(({candidate}) => candidate.at === deferral.through);
			if (bounded.length !== 1) {
				defects.push(
					`the ${AMENDED_EVENT} at ${entry.at} defers task "${deferral.task}" through ${deferral.through}, which names ${bounded.length === 0 ? "no" : `${bounded.length}`} recorded event of that task`,
				);
				continue;
			}
			const boundAt = bounded[0]?.at ?? -1;
			const uncovered = recorded.filter(({at}) => at > boundAt || at > index);
			if (uncovered.length > 0) {
				defects.push(
					`the ${AMENDED_EVENT} at ${entry.at} defers task "${deferral.task}" through ${deferral.through}, and the log records ${uncovered.length} later event(s) of that task: ${uncovered
						.map(({candidate}) => `${bareEvent(candidate.event)} at ${candidate.at}`)
						.join(", ")}`,
				);
				continue;
			}
			deferrals.push({...deferral, at: entry.at});
		}
	}
	return defects.length > 0 ? {_tag: "Undecidable", defects} : {_tag: "Resolved", deferrals};
};

/**
 * The task ids the log's deferrals name — the set the fold excuses from the unknown-task check.
 *
 * Derived from a resolved list rather than read off the payloads directly, so a log whose deferrals
 * do not resolve never reaches a caller as a set of tasks to excuse.
 */
export const deferredTasks = (deferrals: ReadonlyArray<ResolvedDeferral>): ReadonlySet<string> =>
	new Set(deferrals.map((deferral) => deferral.task));
