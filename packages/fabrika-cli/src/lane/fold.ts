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
	type CompiledLane,
	isOperatorEvent,
	OPERATOR_EVENTS,
	type TaskState,
} from "./machine.ts";

/** One appended line of `events.jsonl`: which task, which (namespaced) event, when. */
export interface LogEntry {
	readonly task: string;
	readonly event: string;
	readonly at: string;
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
		const record = parsed as {task?: unknown; event?: unknown; at?: unknown};
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
		entries.push({task: record.task, event: record.event, at: record.at});
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
			.map((entry) => ({type: bareEvent(entry.event)}));
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

export interface LaneStatus {
	readonly stateValue: string | Readonly<Record<string, Readonly<Record<string, string>> | string>>;
	readonly status: "active" | "done";
	readonly context: Readonly<Record<string, unknown>>;
}

/** The pure phase derivation — compound stateValue, `"waiting"` future phases, `noErrors` gating. */
export const deriveStatus = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
): LaneStatus => {
	const errors = Object.entries(states)
		.filter(([taskId, state]) => taskIn(lane, taskId).errorFinals.has(state.type))
		.map(([taskId]) => taskId);
	const context: Record<string, unknown> = {};
	for (const [taskId, state] of Object.entries(states)) {
		context[taskId] = {
			retries: state.retries,
			maxRetries: state.maxRetries,
			...taskIn(lane, taskId).extras,
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
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * Validate and apply one operator event, producing the entry to append. Every refusal is decided
 * BEFORE anything would touch the log, which is what lets a verb prove refuse-without-append. The
 * no-cell refusal is tea's own dispatch guard (`applyCell` → `NoCellError`), surfaced verbatim.
 */
export const applyEvent = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	taskId: string,
	event: string,
	at: string,
): ApplyResult => {
	if (!isOperatorEvent(event)) {
		return {
			_tag: "Refused",
			reason: `"${event}" is outside the operator's six events (${OPERATOR_EVENTS.join("/")})`,
		};
	}
	const previous = deriveStatus(lane, states);
	if (previous.status === "done") {
		return {
			_tag: "Refused",
			reason: `workflow is "${String(previous.stateValue)}" — no further events`,
		};
	}
	const activePhase = lane.phases.find(
		(phase) => typeof (previous.stateValue as Record<string, unknown>)[phase.name] === "object",
	);
	if (activePhase === undefined || !activePhase.tasks.includes(taskId)) {
		return {
			_tag: "Refused",
			reason: `task "${taskId}" is not in the active phase ("${activePhase?.name}")`,
		};
	}
	let next: TaskState;
	try {
		[next] = applyCell<TaskState, {type: string}, never>(
			taskIn(lane, taskId).machine,
			stateIn(states, taskId),
			{
				type: event,
			},
		);
	} catch (error) {
		if (error instanceof NoCellError) {
			return {_tag: "Refused", reason: `${error.name}: ${error.message}`};
		}
		throw error;
	}
	const entry: LogEntry = {task: taskId, event: `${taskId.toUpperCase()}.${event}`, at};
	const current = deriveStatus(lane, {...states, [taskId]: next});
	return {_tag: "Applied", entry, previous, current};
};
