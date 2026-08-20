/**
 * The fold — `events.jsonl` in, lane state out, every invocation from scratch.
 *
 * Fold = state: there is no resident process and no snapshot, a verb re-folds the whole log each
 * run (proven trivially fast at operator scale — #5671, runs 3–12). Tasks are independent regions,
 * so the global log partitions cleanly and each task's messages fold through its own machine.
 *
 * `deriveStatus` is the whole "compound machine": the active phase is the first whose tasks are not
 * all final, and a completed phase with a task in an error final trips the workflow — the
 * `noErrors` gate as a pure derivation, never a machine event. Everything here returns a
 * discriminated union rather than throwing, so a verb's refusal is data it seats on an exit code.
 */
import {applyCell, foldMsgs, NoCellError} from "@demlik/tea";
import {
	bareEvent,
	CLEARED_EVENT,
	type CompiledLane,
	isOperatorEvent,
	type LaneMsg,
	OPERATOR_EVENTS,
	type TaskState,
} from "./machine.ts";

/**
 * One appended line of `events.jsonl`: which task, which (namespaced) event, when — plus, on an
 * event a shell reported through `lane report`, the artifact refs its terminal named (#5712), on a
 * `BLOCKED`, the closed-set cause of the park (#6480), and the lane classes the recorder observed
 * at that moment (ADR 0316). Those three refs are evidence carried verbatim.
 *
 * `round` and `classes` are not evidence — they are the two payloads the fold reads. A `CLEARED`
 * line without a `round` names no round to clear (ADR 0312), and `classes` is what a `class:<name>`
 * guard routes on (ADR 0316).
 */
export interface LogEntry {
	readonly task: string;
	readonly event: string;
	readonly at: string;
	readonly pr?: string;
	readonly comment?: string;
	readonly cause?: string;
	readonly round?: number;
	readonly classes?: ReadonlyArray<string>;
}

export type ParseLogResult =
	| {readonly _tag: "Parsed"; readonly entries: ReadonlyArray<LogEntry>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

/** Parse the log text. A line that does not parse is a defect, never a silently skipped event. */
export const parseLog = (text: string): ParseLogResult => {
	const defects: string[] = [];
	const entries: LogEntry[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			defects.push(`line ${index + 1} is not JSON`);
			continue;
		}
		const record = parsed as {
			task?: unknown;
			event?: unknown;
			at?: unknown;
			pr?: unknown;
			comment?: unknown;
			cause?: unknown;
			round?: unknown;
			classes?: unknown;
		};
		if (
			typeof record !== "object" ||
			record === null ||
			typeof record.task !== "string" ||
			typeof record.event !== "string" ||
			typeof record.at !== "string"
		) {
			defects.push(`line ${index + 1} does not carry string \`task\`/\`event\`/\`at\``);
			continue;
		}
		if (
			(record.pr !== undefined && typeof record.pr !== "string") ||
			(record.comment !== undefined && typeof record.comment !== "string") ||
			(record.cause !== undefined && typeof record.cause !== "string")
		) {
			defects.push(`line ${index + 1} carries a non-string \`pr\`/\`comment\`/\`cause\` field`);
			continue;
		}
		if (record.round !== undefined && !Number.isInteger(record.round)) {
			defects.push(`line ${index + 1} carries a non-integer \`round\` field`);
			continue;
		}
		// A grant that names no round raises the budget by nothing and would fold as a silent no-op —
		// the failure mode ADR 0312 exists to delete, so it is a defect at the parse.
		if (bareEvent(record.event) === CLEARED_EVENT && record.round === undefined) {
			defects.push(`line ${index + 1} is a ${CLEARED_EVENT} event carrying no \`round\``);
			continue;
		}
		if (
			record.classes !== undefined &&
			!(
				Array.isArray(record.classes) &&
				record.classes.every((name) => typeof name === "string" && name !== "")
			)
		) {
			defects.push(`line ${index + 1} carries a \`classes\` field that is not a list of names`);
			continue;
		}
		entries.push({
			task: record.task,
			event: record.event,
			at: record.at,
			...(record.pr === undefined ? {} : {pr: record.pr}),
			...(record.comment === undefined ? {} : {comment: record.comment}),
			...(record.cause === undefined ? {} : {cause: record.cause}),
			...(record.round === undefined ? {} : {round: record.round as number}),
			...(record.classes === undefined ? {} : {classes: record.classes as ReadonlyArray<string>}),
		});
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", entries};
};

export type FoldResult =
	| {readonly _tag: "Folded"; readonly states: Readonly<Record<string, TaskState>>}
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/**
 * The compiler admits a phase's task ids and the fold keys states by those same ids, so both
 * lookups hold by construction; the throw is the invariant's enforcement site, not a code path.
 */
const taskIn = (lane: CompiledLane, taskId: string): CompiledLane["tasks"][string] => {
	const task = lane.tasks[taskId];
	if (task === undefined) throw new Error(`lane machine holds no task "${taskId}"`);
	return task;
};

const stateIn = (states: Readonly<Record<string, TaskState>>, taskId: string): TaskState => {
	const state = states[taskId];
	if (state === undefined) throw new Error(`no folded state for task "${taskId}"`);
	return state;
};

/**
 * Fold the whole log into per-task leaf states. A log only ever appended through
 * {@link applyEvent} replays cleanly; one that names an unknown task or carries an event the
 * machine holds no cell for (a hand edit, or a `workflow.json` swap) is refused with the defect
 * named — never partially applied.
 */
export const foldLog = (lane: CompiledLane, entries: ReadonlyArray<LogEntry>): FoldResult => {
	const defects: string[] = [];
	for (const entry of entries) {
		if (lane.tasks[entry.task] === undefined) {
			defects.push(`log names task "${entry.task}", which is not in this lane's machine`);
		}
	}
	if (defects.length > 0) return {_tag: "Unreplayable", defects};
	const states: Record<string, TaskState> = {};
	for (const [taskId, task] of Object.entries(lane.tasks)) {
		const msgs = entries
			.filter((entry) => entry.task === taskId)
			.map((entry) => ({
				type: bareEvent(entry.event),
				...(entry.round === undefined ? {} : {round: entry.round}),
				...(entry.classes === undefined ? {} : {classes: entry.classes}),
			}));
		try {
			states[taskId] = foldMsgs(task.machine, task.initial, msgs);
		} catch (error) {
			if (error instanceof NoCellError) {
				return {
					_tag: "Unreplayable",
					defects: [`task "${taskId}": the log does not replay — ${error.message}`],
				};
			}
			throw error;
		}
	}
	return {_tag: "Folded", states};
};

/**
 * The cause standing over each task — the `cause` on that task's latest entry, when it carries one.
 *
 * A cause is a property of the event that parked the task, so it stands exactly while that event is
 * the last thing said about the task: the `UNBLOCKED` that clears the park carries none, and the
 * standing cause goes with it. Deriving it that way rather than tracking it as machine state is
 * what keeps the fold total over a log written before this field existed — no cause reads as the
 * bare `BLOCKED` it always was.
 *
 * A `CLEARED` is not the last thing said about a task, because it says nothing about one: it moves
 * no task and clears no park, so a grant landing on a parked lane must leave that park's cause
 * standing (ADR 0312).
 */
export const standingCauses = (
	entries: ReadonlyArray<LogEntry>,
): Readonly<Record<string, string>> => {
	const latest: Record<string, LogEntry> = {};
	for (const entry of entries) {
		if (bareEvent(entry.event) === CLEARED_EVENT) continue;
		latest[entry.task] = entry;
	}
	const causes: Record<string, string> = {};
	for (const [task, entry] of Object.entries(latest)) {
		if (entry.cause !== undefined) causes[task] = entry.cause;
	}
	return causes;
};

export interface LaneStatus {
	readonly stateValue: string | Readonly<Record<string, Readonly<Record<string, string>> | string>>;
	readonly status: "active" | "done";
	readonly context: Readonly<Record<string, unknown>>;
}

/** The pure phase derivation — compound stateValue, `"waiting"` future phases, `noErrors` gating. */
export const deriveStatus = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	causes: Readonly<Record<string, string>> = {},
): LaneStatus => {
	const errors = Object.entries(states)
		.filter(([taskId, state]) => taskIn(lane, taskId).errorFinals.has(state.type))
		.map(([taskId]) => taskId);
	const context: Record<string, unknown> = {};
	for (const [taskId, state] of Object.entries(states)) {
		const cause = causes[taskId];
		context[taskId] = {
			retries: state.retries,
			maxRetries: state.maxRetries,
			...(state.cleared.length === 0 ? {} : {clearedRounds: state.cleared}),
			...taskIn(lane, taskId).extras,
			...(cause === undefined ? {} : {cause}),
		};
	}
	context.errors = errors;

	let active: CompiledLane["phases"][number] | undefined;
	for (const phase of lane.phases) {
		const done = phase.tasks.every((taskId) =>
			taskIn(lane, taskId).finals.has(stateIn(states, taskId).type),
		);
		if (!done) {
			active = phase;
			break;
		}
		if (phase.tasks.some((taskId) => errors.includes(taskId))) {
			return {stateValue: lane.terminals.tripped, status: "done", context};
		}
	}
	if (active === undefined) return {stateValue: lane.terminals.complete, status: "done", context};

	const stateValue: Record<string, Record<string, string> | string> = {
		[active.name]: Object.fromEntries(
			active.tasks.map((taskId) => [taskId, stateIn(states, taskId).type]),
		),
	};
	for (const phase of lane.phases.slice(lane.phases.indexOf(active) + 1)) {
		stateValue[phase.name] = "waiting";
	}
	return {stateValue, status: "active", context};
};

export type TaskResolution =
	| {readonly _tag: "Task"; readonly taskId: string}
	| {readonly _tag: "Unresolved"; readonly reason: string};

/** `--task` may be omitted exactly when the machine leaves no choice. */
export const resolveTask = (lane: CompiledLane, requested: string | null): TaskResolution => {
	const known = Object.keys(lane.tasks);
	if (requested !== null) {
		return lane.tasks[requested] === undefined
			? {
					_tag: "Unresolved",
					reason: `task "${requested}" is not in this lane's machine (tasks: ${known.join(", ")})`,
				}
			: {_tag: "Task", taskId: requested};
	}
	const only = known.length === 1 ? known[0] : undefined;
	return only !== undefined
		? {_tag: "Task", taskId: only}
		: {
				_tag: "Unresolved",
				reason: `--task is required on a lane with ${known.length} tasks (${known.join(", ")})`,
			};
};

export type ApplyResult =
	| {
			readonly _tag: "Applied";
			readonly entry: LogEntry;
			readonly previous: LaneStatus;
			readonly current: LaneStatus;
	  }
	| {
			readonly _tag: "Refused";
			readonly reason: string;
			/**
			 * Which fact the refusal proves, so the verb can seat it on the right exit code without
			 * reading the message. `"unbudgeted-resume"` is the one whose remedy is not a different
			 * event — see {@link applyEvent}.
			 */
			readonly kind: "event" | "unbudgeted-resume";
	  };

const refuseEvent = (reason: string): ApplyResult => ({_tag: "Refused", reason, kind: "event"});

/**
 * Validate and apply one operator event, producing the entry to append. Every refusal is decided
 * BEFORE anything would touch the log, which is what lets a verb prove refuse-without-append. The
 * no-cell refusal is tea's own dispatch guard (`applyCell` → `NoCellError`), surfaced verbatim.
 *
 * One refusal is this function's own rather than the machine table's: an `UNBLOCKED` walking the
 * door out of an error final back into a state whose only non-`PASS` route is guarded, with the
 * budget already spent. The cell exists and the fold would succeed — it would restore the state and
 * not the budget, advertise `active`, and re-freeze on the next `FAIL` (#6570). Under ADR 0312 the
 * budget comes from a recorded `CLEARED` and from nothing else, so the resume is refused loudly with
 * the log unappended instead of resolving to a lane that reads walkable and is not.
 */
export const applyEvent = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	taskId: string,
	event: string,
	at: string,
	classes: ReadonlyArray<string> | null = null,
): ApplyResult => {
	if (!isOperatorEvent(event)) {
		return refuseEvent(
			event === CLEARED_EVENT
				? `"${event}" is not an operator event — a cleared repair round is appended by \`build clear\`, never recorded here (ADR 0312)`
				: `"${event}" is outside the operator's six events (${OPERATOR_EVENTS.join("/")})`,
		);
	}
	const previous = deriveStatus(lane, states);
	// A task sitting in an open final is parked, not finished: the door out is still walkable (ADR
	// 0297). This is a fact about the task alone — a phase holding a parked child beside an
	// unfinished sibling never folds, so the lane's own status says nothing about it.
	const compiled = lane.tasks[taskId];
	const state = states[taskId];
	const inOpenFinal =
		compiled !== undefined && state !== undefined && compiled.openFinals.has(state.type);
	// Only the tripped terminal admits an event once the whole lane has folded — `complete` means
	// every task finished clean, and no door leads out of that.
	const parked =
		previous.status === "done" && previous.stateValue === lane.terminals.tripped && inOpenFinal;
	if (previous.status === "done" && !parked) {
		return refuseEvent(`workflow is "${String(previous.stateValue)}" — no further events`);
	}
	const activePhase = parked
		? lane.phases.find((phase) => phase.tasks.includes(taskId))
		: lane.phases.find(
				(phase) => typeof (previous.stateValue as Record<string, unknown>)[phase.name] === "object",
			);
	if (activePhase === undefined || !activePhase.tasks.includes(taskId)) {
		return refuseEvent(`task "${taskId}" is not in the active phase ("${activePhase?.name}")`);
	}
	const task = taskIn(lane, taskId);
	const from = stateIn(states, taskId);
	let next: TaskState;
	try {
		[next] = applyCell<TaskState, LaneMsg, never>(task.machine, from, {
			type: event,
			...(classes === null ? {} : {classes}),
		});
	} catch (error) {
		if (error instanceof NoCellError) {
			return refuseEvent(`${error.name}: ${error.message}`);
		}
		throw error;
	}
	// A region booted straight into a park left no state behind it, so its door resolves to the park
	// itself; recording that would answer "resumed" for a fold that did not move.
	if (inOpenFinal && next.type === from.type) {
		return refuseEvent(
			`task "${taskId}" booted in "${next.type}" and left no state to resume — the door leads back to itself`,
		);
	}
	if (
		task.errorFinals.has(from.type) &&
		task.guardedStates.has(next.type) &&
		next.retries >= next.maxRetries
	) {
		const stale =
			task.staleGrants.length === 0
				? ""
				: ` This lane's \`workflow.json\` still names a retired \`clearedRounds\` of [${task.staleGrants.join(", ")}], which the compiler no longer honours — re-record each as a ${CLEARED_EVENT} event.`;
		return {
			_tag: "Refused",
			kind: "unbudgeted-resume",
			reason: `task "${taskId}" would resume from "${from.type}" into "${next.type}" at ${next.retries}/${next.maxRetries} retries — the state comes back and the repair budget does not, so every guarded route out of "${next.type}" falls straight back to "${from.type}". Record the founder's cleared round first (\`build clear\`); the two may land in either order.${stale}`,
		};
	}
	const entry: LogEntry = {
		task: taskId,
		event: `${taskId.toUpperCase()}.${event}`,
		at,
		...(classes === null ? {} : {classes}),
	};
	const current = deriveStatus(lane, {...states, [taskId]: next});
	return {_tag: "Applied", entry, previous, current};
};

export type ClearanceResult =
	| {readonly _tag: "Appendable"; readonly entry: LogEntry}
	/** The log already carries this round for this task — set semantics, so nothing to append. */
	| {readonly _tag: "AlreadyHeld"; readonly round: number}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * The entry a recorded clearance appends — `build clear`'s half of ADR 0312, kept beside
 * {@link applyEvent} because both decide appendability from the same fold.
 *
 * It validates far less than an operator event does, and deliberately: a grant moves no task, so
 * there is no cell to miss, no phase to be outside of, and no terminal to be past. A clearance may
 * land on a lane in any state, in any order relative to the `UNBLOCKED` it enables — which is the
 * whole point of anchoring the budget to the event rather than to mutable context.
 */
export const applyClearance = (
	lane: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
	taskId: string,
	round: number,
	at: string,
): ClearanceResult => {
	if (lane.tasks[taskId] === undefined) {
		return {
			_tag: "Refused",
			reason: `task "${taskId}" is not in this lane's machine (tasks: ${Object.keys(lane.tasks).join(", ")})`,
		};
	}
	if (!Number.isInteger(round)) {
		return {_tag: "Refused", reason: `round ${round} is not a whole round to clear`};
	}
	const held = entries.some(
		(entry) =>
			entry.task === taskId && bareEvent(entry.event) === CLEARED_EVENT && entry.round === round,
	);
	if (held) return {_tag: "AlreadyHeld", round};
	return {
		_tag: "Appendable",
		entry: {task: taskId, event: `${taskId.toUpperCase()}.${CLEARED_EVENT}`, at, round},
	};
};
