/**
 * The lane compiler — one `workflow.json` machine document in, one flat tea Transitions machine
 * per task out, everything XState's nesting carried reduced to data (#5673; grounded in the
 * recorded spike runs on #5671/#5672).
 *
 * Structural recognitions replace every name-driven mechanism, and **one guard spelling is read**:
 * a `guard`/`actions` string is otherwise inert data.
 *
 *   - An **array on an event** means guarded: `[taken-when-the-guard-holds, else-fallthrough]`.
 *     Which guard, and only here, is the first arm's own spelling. `class:<name>` reads the lane
 *     class the event carried (see {@link TaskState}); every other spelling is the retry guard, the
 *     one inline `retries < maxRetries` in the compiled cell, whose fallthrough target, when final,
 *     is the task's error final (`frozen`, `tripped`). A class arm spends no retry: it picks which
 *     shell serves the round, and picking is not repairing (ADR 0316).
 *   - A transition **targeting a `history` node** resumes the state the task left, carried as the
 *     `was` field in {@link TaskState} — history-state semantics as data, no pseudo-state.
 *   - A phase's **`onDone` pair** `[{target, guard}, {target}]` names the two workflow terminals
 *     structurally: the last phase's guarded target is the complete terminal, the fallthrough is
 *     the tripped one.
 *   - A **`final` carrying an `on`** is a park rather than an end: it stays in `finals`, so its
 *     phase still folds and its trip still reads, and the door out stays walkable — how `frozen`
 *     takes an `UNBLOCKED` without leaving either set (ADR 0297).
 *
 * Compilation is total over its result type: a document that does not fit comes back as
 * {@link Malformed} with every defect named, never as a machine that half-works.
 */
import type {Machine} from "@demlik/tea";
import {defineMachine} from "@demlik/tea";
import {budgetWith} from "../cap-clearance.ts";
import {RETRY_BUDGET} from "../retry-budget.ts";

/** The operator's whole event vocabulary — the six, closed (#5570 founder session, 2026-08-15). */
export const OPERATOR_EVENTS = ["DONE", "PASS", "FAIL", "BLOCKED", "WIP", "UNBLOCKED"] as const;

export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

export const isOperatorEvent = (event: string): event is OperatorEvent =>
	(OPERATOR_EVENTS as readonly string[]).includes(event);

/**
 * One task's folded state: the leaf, the retry budget, the state it left (`was`), and the lane
 * classes standing over it.
 *
 * `classes` is the routing fact a `class:<name>` guard reads. It is *not* derived here — the
 * compiler reads no diff and no board — it is carried on the event that observed it and folded in
 * below, exactly as `pr`, `comment` and `cause` are carried. It is sticky: an event that names no
 * class leaves the standing set alone, so a lane proven UI-class at `WIP` is still UI-class at the
 * `PASS` that routes its rendered review.
 */
export interface TaskState {
	readonly type: string;
	readonly retries: number;
	readonly maxRetries: number;
	readonly classes: ReadonlyArray<string>;
	readonly was?: string;
}

export interface LaneMsg {
	readonly type: string;
	/** The lane classes the recorder observed; absent leaves {@link TaskState.classes} standing. */
	readonly classes?: ReadonlyArray<string>;
}

export type TaskMachine = Machine<TaskState, LaneMsg, never, never, unknown>;

export interface CompiledTask {
	readonly machine: TaskMachine;
	readonly initial: TaskState;
	/** Every `type: "final"` state name in the task's region. */
	readonly finals: ReadonlySet<string>;
	/** The finals reached as a guarded array's fallthrough — the task's error terminals. */
	readonly errorFinals: ReadonlySet<string>;
	/** The finals that hold a cell for some event — parks the lane trips on and resumes from. */
	readonly openFinals: ReadonlySet<string>;
	/** The task's `context` entry minus the retry bookkeeping — passed through to status. */
	readonly extras: Readonly<Record<string, unknown>>;
}

export interface CompiledLane {
	readonly tasks: Readonly<Record<string, CompiledTask>>;
	readonly phases: ReadonlyArray<{readonly name: string; readonly tasks: ReadonlyArray<string>}>;
	/** The workflow's two terminal names, read off the last phase's `onDone` pair. */
	readonly terminals: {readonly complete: string; readonly tripped: string};
	/**
	 * What fires this lane, as the document declares it — a chore workflow's own field (#5840). Read
	 * and carried rather than ignored, so a mistyped declaration is a defect instead of a silence;
	 * what a trigger name *means* is the caller's, exactly as a guard name is.
	 */
	readonly trigger?: string;
}

export type CompileResult =
	| {readonly _tag: "Compiled"; readonly lane: CompiledLane}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

type Cell = (state: TaskState, msg: LaneMsg) => readonly [TaskState, readonly never[]];

/**
 * The one guard spelling the compiler reads: `class:<name>` takes the arm when `<name>` stands over
 * the task. Anything else — `retriesRemaining`, a per-task spelling, a name nobody defined — is the
 * retry guard, which is what keeps every document written before this shape existed compiling
 * byte-for-byte the same.
 */
const CLASS_GUARD = /^class:([a-z][a-z0-9-]*)$/;

const classGuardOf = (arm: unknown): string | undefined => {
	if (!isRecord(arm) || typeof arm.guard !== "string") return undefined;
	return CLASS_GUARD.exec(arm.guard)?.[1];
};

/** Fold the classes an event carried into the state before any guard reads them. */
const withClasses = (state: TaskState, msg: LaneMsg): TaskState =>
	msg.classes === undefined ? state : {...state, classes: msg.classes};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `TASK_1.DONE` and `DONE` are the same operator event; the namespace is presentation. */
export const bareEvent = (event: string): string => {
	const dot = event.indexOf(".");
	return dot === -1 ? event : event.slice(dot + 1);
};

const nodeType = (node: unknown): string | undefined =>
	isRecord(node) && typeof node.type === "string" ? node.type : undefined;

interface RegionCompilation {
	readonly task?: CompiledTask;
	readonly defects: ReadonlyArray<string>;
}

const compileRegion = (taskId: string, region: unknown, context: unknown): RegionCompilation => {
	const defects: string[] = [];
	if (!isRecord(region) || !isRecord(region.states) || typeof region.initial !== "string") {
		return {defects: [`task "${taskId}": region must carry string \`initial\` and \`states\``]};
	}
	const states = region.states;
	const initialState = region.initial;
	if (states[initialState] === undefined) {
		defects.push(`task "${taskId}": initial state "${initialState}" is not in \`states\``);
	}

	const finals = new Set<string>();
	const errorFinals = new Set<string>();
	for (const [name, node] of Object.entries(states)) {
		if (nodeType(node) === "final") finals.add(name);
	}

	const table: Record<string, Record<string, Cell>> = {};
	for (const [stateName, node] of Object.entries(states)) {
		if (nodeType(node) === "history") continue;
		const cells: Record<string, Cell> = {};
		table[stateName] = cells;
		if (!isRecord(node)) {
			defects.push(`task "${taskId}": state "${stateName}" is not an object`);
			continue;
		}
		const on = node.on ?? {};
		if (!isRecord(on)) {
			defects.push(`task "${taskId}": state "${stateName}" carries a non-object \`on\``);
			continue;
		}
		for (const [eventName, transition] of Object.entries(on)) {
			const msg = bareEvent(eventName);
			if (!isOperatorEvent(msg)) {
				defects.push(
					`task "${taskId}": state "${stateName}" listens for "${eventName}" — outside the operator's six (${OPERATOR_EVENTS.join("/")})`,
				);
				continue;
			}
			if (Array.isArray(transition)) {
				const targets = transition.map((arm) =>
					isRecord(arm) && typeof arm.target === "string" ? arm.target : undefined,
				);
				const [taken, fallthrough] = targets;
				if (transition.length !== 2 || taken === undefined || fallthrough === undefined) {
					defects.push(
						`task "${taskId}": guarded "${eventName}" must be a two-arm array of \`{target}\` — [taken-when-the-guard-holds, else-fallthrough]`,
					);
					continue;
				}
				for (const target of [taken, fallthrough]) {
					if (states[target] === undefined) {
						defects.push(`task "${taskId}": "${eventName}" targets unknown state "${target}"`);
					}
				}
				const laneClass = classGuardOf(transition[0]);
				if (laneClass !== undefined) {
					cells[msg] = (s, m) => {
						const c = withClasses(s, m);
						const target = c.classes.includes(laneClass) ? taken : fallthrough;
						return [{...c, type: target, was: c.type}, []];
					};
					continue;
				}
				if (finals.has(fallthrough)) errorFinals.add(fallthrough);
				cells[msg] = (s, m) => {
					const c = withClasses(s, m);
					return c.retries < c.maxRetries
						? [{...c, type: taken, retries: c.retries + 1, was: c.type}, []]
						: [{...c, type: fallthrough, was: c.type}, []];
				};
				continue;
			}
			if (typeof transition !== "string") {
				defects.push(`task "${taskId}": "${eventName}" is neither a target nor a guarded array`);
				continue;
			}
			if (states[transition] === undefined) {
				defects.push(`task "${taskId}": "${eventName}" targets unknown state "${transition}"`);
				continue;
			}
			if (nodeType(states[transition]) === "history") {
				cells[msg] = (s, m) => {
					const c = withClasses(s, m);
					return [{...c, type: c.was ?? initialState}, []];
				};
			} else {
				const target = transition;
				cells[msg] = (s, m) => {
					const c = withClasses(s, m);
					return [{...c, type: target, was: c.type}, []];
				};
			}
		}
	}
	if (defects.length > 0) return {defects};

	const openFinals = new Set(
		Object.entries(table)
			.filter(([name, cells]) => finals.has(name) && Object.keys(cells).length > 0)
			.map(([name]) => name),
	);

	const ctx = isRecord(context) ? context : {};
	const declared = typeof ctx.maxRetries === "number" ? ctx.maxRetries : RETRY_BUDGET;
	// The lane guard and `build verdicts`'s `capReached` spend one grant identically, which is why the
	// budget is derived there rather than tallied here — see `../cap-clearance.ts` (#5959, #6137).
	const cleared = Array.isArray(ctx.clearedRounds)
		? ctx.clearedRounds.filter((round): round is number => typeof round === "number")
		: [];
	const maxRetries = budgetWith(declared, cleared);
	// A document may seed the classes a lane starts under; every later change rides an event, so a
	// non-array declaration is a silence rather than a defect the compiler could act on.
	const classes = Array.isArray(ctx.classes)
		? ctx.classes.filter((name): name is string => typeof name === "string")
		: [];
	const {maxRetries: _max, retries: _retries, classes: _classes, ...extras} = ctx;
	const initial: TaskState = {type: initialState, retries: 0, maxRetries, classes};
	// The Transitions mapped type demands a cell for every (state × msg) pair; a lane machine is
	// compiled from data and deliberately partial — the absent cells ARE the refusal contract
	// (`applyCell` throws `NoCellError` on them). One cast at the construction boundary.
	const machine = defineMachine<TaskState, LaneMsg, never, never, unknown>({
		init: (loaded) => [loaded ?? initial, []],
		update: table as never,
	});
	return {task: {machine, initial, finals, errorFinals, openFinals, extras}, defects: []};
};

/** The two targets of a phase's `onDone` pair: `[guarded success, fallthrough trip]`. */
const onDoneTargets = (
	phaseName: string,
	onDone: unknown,
): {targets?: readonly [string, string]; defect?: string} => {
	const defect = `phase "${phaseName}": \`onDone\` must be a two-arm array of \`{target}\` — [{target, guard}, {target}]`;
	if (!Array.isArray(onDone) || onDone.length !== 2) return {defect};
	const [success, trip] = onDone.map((arm) =>
		isRecord(arm) && typeof arm.target === "string" ? arm.target : undefined,
	);
	return success === undefined || trip === undefined
		? {defect}
		: {targets: [success, trip] as const};
};

/**
 * Compile one machine document. Phases are the machine's `parallel` states in declaration order;
 * everything else at the machine level is either a terminal named by an `onDone` pair, or a defect.
 */
export const compile = (workflow: unknown): CompileResult => {
	const defects: string[] = [];
	const machineDef = isRecord(workflow) ? workflow.machine : undefined;
	if (!isRecord(machineDef) || !isRecord(machineDef.states)) {
		return {_tag: "Malformed", defects: ["document must carry a `machine.states` object"]};
	}
	const context = isRecord(machineDef.context) ? machineDef.context : {};
	const declaredTrigger = isRecord(workflow) ? workflow.trigger : undefined;
	if (declaredTrigger !== undefined && typeof declaredTrigger !== "string") {
		defects.push("document `trigger` must be a string naming what fires this lane");
	}

	const machineStates = machineDef.states;
	const tasks: Record<string, CompiledTask> = {};
	const phases: Array<{name: string; tasks: string[]}> = [];
	const gateTargets = new Set<string>();
	let terminals: {complete: string; tripped: string} | undefined;
	for (const [phaseName, node] of Object.entries(machineStates)) {
		if (nodeType(node) !== "parallel" || !isRecord(node)) continue;
		const regions = node.states;
		if (!isRecord(regions) || Object.keys(regions).length === 0) {
			defects.push(`phase "${phaseName}": a parallel phase must carry task regions in \`states\``);
			continue;
		}
		const phaseTasks: string[] = [];
		for (const [taskId, region] of Object.entries(regions)) {
			const compiled = compileRegion(taskId, region, context[taskId]);
			defects.push(...compiled.defects);
			if (compiled.task !== undefined) tasks[taskId] = compiled.task;
			phaseTasks.push(taskId);
		}
		phases.push({name: phaseName, tasks: phaseTasks});
		const gate = onDoneTargets(phaseName, node.onDone);
		if (gate.defect !== undefined) defects.push(gate.defect);
		// Every phase names the same trip terminal; the LAST phase's success target is the
		// workflow's complete terminal, because earlier ones target the next phase.
		if (gate.targets !== undefined) {
			for (const target of gate.targets) {
				gateTargets.add(target);
				if (machineStates[target] === undefined) {
					defects.push(
						`phase "${phaseName}": \`onDone\` targets unknown machine-level state "${target}"`,
					);
				}
			}
			terminals = {complete: gate.targets[0], tripped: gate.targets[1]};
		}
	}
	// A machine-level state the loop above did not compile is a terminal or a defect — never
	// dropped silently: a phase missing `"type": "parallel"` must refuse, not half-compile.
	for (const [name, node] of Object.entries(machineStates)) {
		if (nodeType(node) === "parallel" && isRecord(node)) continue;
		if (nodeType(node) !== "final") {
			defects.push(
				`machine-level state "${name}" is neither a \`parallel\` phase nor a \`final\` terminal`,
			);
		} else if (!gateTargets.has(name)) {
			defects.push(`machine-level final "${name}" is targeted by no phase's \`onDone\` pair`);
		}
	}
	if (phases.length === 0) defects.push("machine holds no `parallel` phase state");
	if (defects.length > 0) return {_tag: "Malformed", defects};
	if (terminals === undefined) {
		return {_tag: "Malformed", defects: ["no phase carried a readable `onDone` pair"]};
	}
	return {
		_tag: "Compiled",
		lane: {
			tasks,
			phases,
			terminals,
			...(typeof declaredTrigger === "string" ? {trigger: declaredTrigger} : {}),
		},
	};
};

/** Parse and compile in one step — for a caller holding the document's bytes off disk. */
export const compileText = (text: string): CompileResult => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {_tag: "Malformed", defects: ["the document is not JSON"]};
	}
	return compile(parsed);
};

export interface LaneTopology {
	readonly phases: CompiledLane["phases"];
	readonly terminals: CompiledLane["terminals"];
	readonly trigger?: string;
	readonly tasks: Readonly<
		Record<
			string,
			{
				readonly initial: string;
				readonly maxRetries: number;
				/** Per state, the events it holds a cell for — everything else refuses. */
				readonly states: Readonly<Record<string, ReadonlyArray<string>>>;
			}
		>
	>;
}

/** The compiled machines summarized as data — what `lane print` answers with. */
export const topology = (lane: CompiledLane): LaneTopology => ({
	phases: lane.phases,
	terminals: lane.terminals,
	...(lane.trigger === undefined ? {} : {trigger: lane.trigger}),
	tasks: Object.fromEntries(
		Object.entries(lane.tasks).map(([taskId, task]) => [
			taskId,
			{
				initial: task.initial.type,
				maxRetries: task.initial.maxRetries,
				states: Object.fromEntries(
					Object.entries(task.machine.update as Record<string, Record<string, unknown>>).map(
						([state, cells]) => [state, Object.keys(cells)],
					),
				),
			},
		]),
	),
});
