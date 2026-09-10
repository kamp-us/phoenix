/**
 * The amendment judgement — may this lane's machine be re-derived from the epic's current topology?
 *
 * The question `lane migrate` asks one axis over, under a rule that had to be new. That sweep is
 * safe exactly when the log replays through the candidate to the same per-task leaf, and it refuses
 * a candidate whose task set drops one of the lane's. A topology amendment breaks that on purpose: a
 * newly added child has no history to replay, and a not-started one may be re-sequenced into a
 * later phase, which is the whole point. So the rule here binds a narrower set — **the tasks that
 * carry history, plus the ones the lane already landed** — and leaves the rest free to move.
 *
 * Nothing here reads disk or the board: two compiled machines and the log go in, one verdict comes
 * out, and the verb writes only on the accepting one.
 */
import {foldLog, type LogEntry} from "./fold.ts";
import {AMENDED_EVENT, bareEvent, type CompiledLane} from "./machine.ts";

/** A task whose landing this amendment would erase, and the final it landed in. */
export interface LandedTask {
	readonly task: string;
	readonly state: string;
}

export type AmendVerdict =
	/** The re-derivation is safe. `added`/`dropped` are the task-set difference it makes. */
	| {
			readonly _tag: "Amendable";
			readonly tasks: ReadonlyArray<string>;
			readonly added: ReadonlyArray<string>;
			readonly dropped: ReadonlyArray<string>;
	  }
	/** The lane's own log already does not replay through the machine it is running. */
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>}
	/** The new topology drops a task the ledger proves landed. */
	| {readonly _tag: "DropsLanded"; readonly landed: ReadonlyArray<LandedTask>}
	/** A task carrying history cannot replay to the leaf it stands on. */
	| {readonly _tag: "Unreachable"; readonly reasons: ReadonlyArray<string>};

/**
 * Where a region ENDS clean — a final the task reached rather than fell into.
 *
 * Structural, never a name match: `landed` is a child's success final and `shipped` the tail's, and
 * both are `final` states no guarded array falls through to. An error final (`human:budget-spent`,
 * a `frozen` boot) is a task that stopped, not one that landed, so dropping it from the topology is
 * an ordinary re-plan.
 */
const isLanded = (lane: CompiledLane, task: string, state: string): boolean => {
	const compiled = lane.tasks[task];
	if (compiled === undefined) return false;
	return compiled.finals.has(state) && !compiled.errorFinals.has(state);
};

/**
 * Judge one re-derivation. The order is the rule: the lane's own replay first (a lane already broken
 * is not one to amend), then the landings, then the histories — so the refusal a caller reads names
 * the fact it can act on rather than the first symptom downstream of it.
 */
export const judgeAmendment = (
	current: CompiledLane,
	candidate: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
): AmendVerdict => {
	const before = foldLog(current, entries);
	if (before._tag !== "Folded") return {_tag: "Unreplayable", defects: before.defects};

	const landed = Object.entries(before.states)
		.filter(([task, state]) => isLanded(current, task, state.type))
		.filter(([task]) => candidate.tasks[task] === undefined)
		.map(([task, state]) => ({task, state: state.type}));
	if (landed.length > 0) return {_tag: "DropsLanded", landed};

	// Before the candidate fold, because that fold answers this case as an unknown-task defect naming
	// the machine rather than the amendment — a reader sent at `.fabrika/lanes/<n>/workflow.json` for
	// a fault that is in the epic body.
	const historied = new Set(
		entries.filter((entry) => bareEvent(entry.event) !== AMENDED_EVENT).map((entry) => entry.task),
	);
	const strandedByDrop = [...historied]
		.filter((task) => candidate.tasks[task] === undefined)
		.sort()
		.map(
			(task) =>
				`task "${task}" carries recorded history and the new topology places it in no phase`,
		);
	if (strandedByDrop.length > 0) return {_tag: "Unreachable", reasons: strandedByDrop};

	const after = foldLog(candidate, entries);
	if (after._tag !== "Folded") return {_tag: "Unreachable", reasons: after.defects};

	const moved = [...historied].sort().flatMap((task) => {
		const from = before.states[task];
		const to = after.states[task];
		if (from === undefined || to === undefined || from.type === to.type) return [];
		return [
			`task "${task}" stands at "${from.type}" and its log replays through the re-derived machine to "${to.type}"`,
		];
	});
	if (moved.length > 0) return {_tag: "Unreachable", reasons: moved};

	const held = new Set(Object.keys(current.tasks));
	const tasks = Object.keys(candidate.tasks);
	return {
		_tag: "Amendable",
		tasks,
		added: tasks.filter((task) => !held.has(task)),
		dropped: [...held].filter((task) => candidate.tasks[task] === undefined).sort(),
	};
};
