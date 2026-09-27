/**
 * Which recorded integrate `FAIL` may take a late exit-and-head pair, and the line that attaches it
 * — the offline half of `lane attach-integrate`.
 *
 * `build claim` reads an epic child's integrate `FAIL` off the `integrate: {exit, head}` pair on its
 * ledger line ([`integrate-failure.ts`](integrate-failure.ts)). A lane that recorded the `FAIL`
 * before the pair existed holds a pair-less line, and its task has already folded back into `build`,
 * where `lane report` refuses the pair — so no builder can take the repair the machine routed to.
 * The log is append-only, so the pair arrives on a `CORRECTED` line naming the `FAIL` by its `at`,
 * exactly as `lane reconcile` supersedes a `partial`; no recorded line changes.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9882
 */
import {applyCorrections, foldLog, type LogEntry} from "./fold.ts";
import {INTEGRATE_STATE, type IntegrateFailure} from "./integrate-failure.ts";
import {bareEvent, CORRECTED_EVENT, type CompiledLane} from "./machine.ts";

export type Attachment =
	/** The named line is a pair-less integrate `FAIL` still standing; `entry` is what to append. */
	| {readonly _tag: "Attachable"; readonly entry: LogEntry}
	/** The named line is not one the pair may ride, and `reason` says why. */
	| {readonly _tag: "Refused"; readonly reason: string}
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/**
 * Judge whether `failure` may be attached to the line of `task` recorded at `target`, and build the
 * `CORRECTED` line that attaches it.
 *
 * Three things make a line the one this repair is for: it is a `FAIL`, the task stood in `integrate`
 * when it was recorded, and no later `DONE` on the task has answered it. A `DONE` retires an
 * integrate `FAIL` for `build claim` (`standingIntegrateFailure`), so attaching to a retired
 * one would reopen a repair nobody owes. A line that already carries its own pair was recorded by
 * `lane report` with it, so there is nothing missing to attach.
 */
export const judgeAttachment = (
	lane: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
	task: string,
	target: string,
	failure: IntegrateFailure,
	now: string,
): Attachment => {
	const resolved = applyCorrections(entries);
	if (resolved._tag === "Undecidable") return {_tag: "Unreplayable", defects: resolved.defects};
	const log = resolved.entries;
	const matches = log.flatMap((entry, index) =>
		entry.task === task && entry.at === target ? [index] : [],
	);
	const index = matches[0];
	if (index === undefined || matches.length > 1) {
		return {
			_tag: "Refused",
			reason: `${matches.length === 0 ? "no" : `${matches.length}`} recorded line${matches.length > 1 ? "s" : ""} of task "${task}" stand${matches.length > 1 ? "" : "s"} at ${target} — the pair attaches to exactly one`,
		};
	}
	const named = log[index] as LogEntry;
	const event = bareEvent(named.event);
	if (event !== "FAIL") {
		return {
			_tag: "Refused",
			reason: `the line of task "${task}" at ${target} is a ${event}, not an integrate FAIL`,
		};
	}
	const recorded = entries.find(
		(entry) =>
			entry.task === task && entry.at === target && bareEvent(entry.event) !== CORRECTED_EVENT,
	);
	if (recorded?.integrate !== undefined) {
		return {
			_tag: "Refused",
			reason: `the FAIL of task "${task}" at ${target} already carries its own pair (exit ${recorded.integrate.exit}, head ${recorded.integrate.head}) — lane report recorded it, so nothing is missing`,
		};
	}
	const before = foldLog(lane, log.slice(0, index));
	if (before._tag === "Unreplayable") return before;
	const leaf = before.states[task]?.type ?? "";
	if (leaf !== INTEGRATE_STATE) {
		return {
			_tag: "Refused",
			reason: `the FAIL of task "${task}" at ${target} is out of "${leaf === "" ? "no state" : leaf}", not an integrate FAIL`,
		};
	}
	const answered = log
		.slice(index + 1)
		.find((entry) => entry.task === task && bareEvent(entry.event) === "DONE");
	if (answered !== undefined) {
		return {
			_tag: "Refused",
			reason: `the integrate FAIL of task "${task}" at ${target} was answered by the DONE at ${answered.at} — a pair on it would reopen a repair nobody owes`,
		};
	}
	return {
		_tag: "Attachable",
		entry: {
			task,
			event: `${task.toUpperCase()}.${CORRECTED_EVENT}`,
			at: now,
			corrects: target,
			integrate: failure,
		},
	};
};
