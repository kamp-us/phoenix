/**
 * The lane compiler — one `workflow.json` machine document in, one flat tea Transitions machine
 * per task out, everything XState's nesting carried reduced to data (#5673; grounded in the
 * recorded spike runs on #5671/#5672).
 *
 * Structural recognitions replace every name-driven mechanism, and **two guard spellings are read**:
 * a `guard`/`actions` string is otherwise inert data.
 *
 *   - An **array on an event** means guarded: `[taken-when-the-guard-holds, else-fallthrough]`, and
 *     the fallthrough target, when final, is the task's error final (`frozen`, `tripped`) — except
 *     under the two routing spellings below, whose fallthrough is the ordinary path and carries no
 *     error. The first arm's own spelling picks the guard, and only three kinds exist.
 *     `class:<name>` reads the lane class the event carried (see {@link TaskState}) and spends
 *     nothing: it picks which shell serves the round, and picking is not repairing (ADR 0317).
 *     {@link PARTIAL_GUARD} reads whether the merge this event reports closed its issue, and spends
 *     nothing either: a `Part of #N` merge is real work landing, so the lane goes round again rather
 *     than folding to a terminal over an issue the board still calls buildable (ADR 0343). Every
 *     other spelling is the budget guard, one inline counter comparison in the compiled cell, and
 *     **which counter it spends is the event's own polarity**: `FAIL` is a repair round and spends
 *     `retries`, every other event is a wait and spends `waits`. A queue dwell must not eat the
 *     budget a later repair draws on, and reading that off the event keeps it structural — beyond
 *     the two routing spellings, no guard name is consulted (ADR 0313).
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
 *
 * One cell is the compiler's rather than the document's: {@link CLEARED_EVENT}, injected into every
 * state, which raises the retry budget and moves nothing (ADR 0312). A document that declares it is
 * still a defect — the budget is a fold over recorded events, so a grant is a line in
 * `events.jsonl`, never a field the compiler reads out of mutable context.
 */
import type {Machine} from "@demlik/tea";
import {defineMachine} from "@demlik/tea";
import {budgetWith} from "../cap-clearance.ts";
import {RETRY_BUDGET} from "../retry-budget.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";

/** The operator's whole event vocabulary — the six, closed (#5570 founder session, 2026-08-15). */
export const OPERATOR_EVENTS = ["DONE", "PASS", "FAIL", "BLOCKED", "WIP", "UNBLOCKED"] as const;

export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

export const isOperatorEvent = (event: string): event is OperatorEvent =>
	(OPERATOR_EVENTS as readonly string[]).includes(event);

/**
 * The seventh event, and the one no operator records: a founder's cleared repair round, appended by
 * `build clear` (ADR 0312). It targets nothing — it raises the budget from its own position in the
 * log forward — so it opens no door out of a park and leaves 0297's transition vocabulary at six.
 */
export const CLEARED_EVENT = "CLEARED";

/**
 * The eighth event, and the only line that names another line: a correction, appended by
 * `lane reconcile` to say what a recorded event's routing payload should have been (ADR 0344).
 *
 * It reaches no machine at all — no state holds a cell for it, and the fold consumes it before any
 * message is dispatched. That is the design rather than an omission: a correction is a fact about
 * the log, not about the task, so it amends a line the machine has long since folded past without
 * needing a door out of the terminal that fold reached.
 */
export const CORRECTED_EVENT = "CORRECTED";

/**
 * One task's folded state: the leaf, its two budgets, the state it left (`was`), and the grants
 * applied so far — `cleared` is the fold's own tally of {@link CLEARED_EVENT} rounds, which is what
 * makes `maxRetries` a function of the log's prefix rather than of a document anyone can edit.
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
	readonly cleared: ReadonlyArray<number>;
	readonly classes: ReadonlyArray<string>;
	/** Re-folds spent waiting on something outside the lane — never the repair budget above. */
	readonly waits: number;
	readonly maxWaits: number;
	readonly was?: string;
}

export interface LaneMsg {
	readonly type: string;
	/** The round a {@link CLEARED_EVENT} clears; absent on every operator event. */
	readonly round?: number;
	/** The lane classes the recorder observed; absent leaves {@link TaskState.classes} standing. */
	readonly classes?: ReadonlyArray<string>;
	/**
	 * Waits this event grants, raising {@link TaskState.maxWaits} from its own position in the log.
	 *
	 * It rides the resume rather than arriving as an eighth event, because the point is that ONE
	 * recorded line both clears the park and buys the read the resumed lane needs: a bare `UNBLOCKED`
	 * out of `human:queue-stall` restores a state whose wait budget is spent, and the fold refuses
	 * exactly that (ADR 0313). `recipe unpark` grants it once it has proven the queue moved; a
	 * human's `lane transition --grant-wait` is the fallback for when that read cannot run.
	 */
	readonly waitGrant?: number;
	/**
	 * Whether the merge this event reports left its issue undischarged — the `merge:partial` guard's
	 * whole input, relayed off `lane prove`'s closure read (ADR 0343).
	 *
	 * Unlike {@link TaskState.classes} it is not sticky and folds into no state field: it is a fact
	 * about *this* merge, so a lane that partially merged, went round and closed properly must read
	 * the second merge's answer and not the first's.
	 */
	readonly partial?: boolean;
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
	/**
	 * The states holding a **retries**-guarded cell — the ones whose only non-`PASS` route out is
	 * gated on `retries < maxRetries`. Read at resume time, where landing in one with the budget
	 * spent means the state was restored and the budget was not (#6570). A wait-guarded cell is not
	 * one of these: its spent fallthrough is a human park that names the stall, not a fall back into
	 * the error final the resume just left (ADR 0313).
	 */
	readonly guardedStates: ReadonlySet<string>;
	/**
	 * Per **waits**-guarded state, the parks its spent-budget arm falls into — `ship:queued`'s `WIP`
	 * to `human:queue-stall`, and nothing else in today's machine.
	 *
	 * The wait axis's own resume read, and it needs the pairing where {@link guardedStates} needs
	 * only the name: a retry-guarded state's fallthrough is a final, so `errorFinals` already says
	 * where a resume came from. A wait park is a plain state, so the pair is what tells the fold that
	 * a resume lands back in the state whose spent guard produced this very park — rather than in one
	 * a differently-caused park happens to share (ADR 0313).
	 */
	readonly waitParks: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * Per state holding a {@link PARTIAL_GUARD}-guarded cell, the events that cell reads — the places
	 * where a recorded line's `partial` payload is the whole difference between two targets.
	 *
	 * Carried so a reader can locate a misrouted line off the machine instead of off a state-name
	 * list: which state ships, and which event lands the merge, is the document's call. An epic
	 * tail's emitted region declares no partial arm, so it yields nothing here — ADR 0343's carve-out
	 * falls out of the compilation rather than being restated as a special case.
	 */
	readonly partialStates: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * Rounds a retired `clearedRounds` context field names, which the compiler no longer honours
	 * (ADR 0312). Carried so a refusal can name the repair — re-record each as a `CLEARED` event —
	 * rather than leaving an operator staring at a grant that silently buys nothing.
	 */
	readonly staleGrants: ReadonlyArray<number>;
	/** The task's `context` entry minus the two budgets' bookkeeping — passed through to status. */
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
 * The first guard spelling the compiler reads: `class:<name>` takes the arm when `<name>` stands
 * over the task. Anything the two routing spellings do not match — `retriesRemaining`, a per-task
 * spelling, a name nobody defined — is the budget guard, whose counter the event's polarity picks,
 * which is what keeps every document written before this shape existed compiling byte-for-byte the
 * same.
 */
const CLASS_GUARD = /^class:([a-z][a-z0-9-]*)$/;

const classGuardOf = (arm: unknown): string | undefined => {
	if (!isRecord(arm) || typeof arm.guard !== "string") return undefined;
	return CLASS_GUARD.exec(arm.guard)?.[1];
};

/**
 * The second: the arm a merge that did not close its issue takes ({@link LaneMsg.partial}).
 *
 * Namespaced like `class:<name>` rather than spelled bare, because a bare word falls through to the
 * budget guard: a typo would compile, match nothing, spend a wait, and fold the lane to the terminal
 * this arm exists to divert it from — silently, which is the failure ADR 0317 named on the class
 * axis and this axis inherits.
 */
export const PARTIAL_GUARD = "merge:partial";

const partialGuarded = (arm: unknown): boolean => isRecord(arm) && arm.guard === PARTIAL_GUARD;

/**
 * Fold the payloads an event carried into the state before any guard reads them — the classes a
 * `class:<name>` arm routes on, and the waits the event grants.
 *
 * Applying the grant here rather than in one cell is what makes it a property of the event instead
 * of the edge: the budget stays a fold over the recorded log, and replaying that log twice yields
 * the same `maxWaits` because the grant is read off the line rather than accumulated in context.
 */
const withPayload = (state: TaskState, msg: LaneMsg): TaskState => {
	const classed = msg.classes === undefined ? state : {...state, classes: msg.classes};
	return msg.waitGrant === undefined
		? classed
		: {...classed, maxWaits: classed.maxWaits + msg.waitGrant};
};

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

	const ctx = isRecord(context) ? context : {};
	const declared = typeof ctx.maxRetries === "number" ? ctx.maxRetries : RETRY_BUDGET;

	const finals = new Set<string>();
	const errorFinals = new Set<string>();
	const guardedStates = new Set<string>();
	const waitParks = new Map<string, Set<string>>();
	const partialStates = new Map<string, Set<string>>();
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
			if (msg === CLEARED_EVENT) {
				defects.push(
					`task "${taskId}": state "${stateName}" declares "${eventName}" — a clearance is the compiler's own cell on every state, never a document's transition (ADR 0312)`,
				);
				continue;
			}
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
						`task "${taskId}": guarded "${eventName}" must be a two-arm array of \`{target}\` — [loop-while-budget-remains, else-fallthrough]`,
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
						const c = withPayload(s, m);
						const target = c.classes.includes(laneClass) ? taken : fallthrough;
						return [{...c, type: target, was: c.type}, []];
					};
					continue;
				}
				if (partialGuarded(transition[0])) {
					const reads = partialStates.get(stateName) ?? new Set<string>();
					reads.add(msg);
					partialStates.set(stateName, reads);
					cells[msg] = (s, m) => {
						const c = withPayload(s, m);
						const target = m.partial === true ? taken : fallthrough;
						return [{...c, type: target, was: c.type}, []];
					};
					continue;
				}
				if (finals.has(fallthrough)) errorFinals.add(fallthrough);
				if (msg === "FAIL") guardedStates.add(stateName);
				else {
					const parks = waitParks.get(stateName) ?? new Set<string>();
					parks.add(fallthrough);
					waitParks.set(stateName, parks);
				}
				cells[msg] =
					msg === "FAIL"
						? (s, m) => {
								const c = withPayload(s, m);
								return c.retries < c.maxRetries
									? [{...c, type: taken, retries: c.retries + 1, was: c.type}, []]
									: [{...c, type: fallthrough, was: c.type}, []];
							}
						: (s, m) => {
								const c = withPayload(s, m);
								return c.waits < c.maxWaits
									? [{...c, type: taken, waits: c.waits + 1, was: c.type}, []]
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
					const c = withPayload(s, m);
					return [{...c, type: c.was ?? initialState}, []];
				};
			} else {
				const target = transition;
				cells[msg] = (s, m) => {
					const c = withPayload(s, m);
					return [{...c, type: target, was: c.type}, []];
				};
			}
		}
	}
	if (defects.length > 0) return {defects};

	// Read BEFORE the clearance cell is injected: an open final is one the DOCUMENT left a door in.
	// The injected cell targets nothing, so counting it would read every final as a park (ADR 0312).
	const openFinals = new Set(
		Object.entries(table)
			.filter(([name, cells]) => finals.has(name) && Object.keys(cells).length > 0)
			.map(([name]) => name),
	);

	// The lane guard and `build verdicts`'s `capReached` spend one grant identically, which is why the
	// budget is derived there rather than tallied here — see `../cap-clearance.ts` (#5959, #6137).
	const clearedCell: Cell = (s, msg) => {
		const round = msg.round;
		// Set-semantic by the round it names, so a re-recorded grant buys nothing (ADR 0312).
		if (round === undefined || s.cleared.includes(round)) return [s, []];
		const cleared = [...s.cleared, round].sort((a, b) => a - b);
		return [{...s, cleared, maxRetries: budgetWith(declared, cleared)}, []];
	};
	for (const cells of Object.values(table)) cells[CLEARED_EVENT] = clearedCell;

	const staleGrants = Array.isArray(ctx.clearedRounds)
		? ctx.clearedRounds.filter((round): round is number => typeof round === "number")
		: [];
	// A document may seed the classes a lane starts under; every later change rides an event, so a
	// non-array declaration is a silence rather than a defect the compiler could act on.
	const classes = Array.isArray(ctx.classes)
		? ctx.classes.filter((name): name is string => typeof name === "string")
		: [];
	// A cap clearance buys a repair round and never a longer wait: `clearedCell` raises `maxRetries`
	// alone, so the wait budget is a declared constant no recorded event moves (ADRs 0312, 0313).
	const maxWaits = typeof ctx.maxWaits === "number" ? ctx.maxWaits : WAIT_BUDGET;
	const {
		maxRetries: _max,
		retries: _retries,
		clearedRounds: _cleared,
		classes: _classes,
		maxWaits: _maxWaits,
		waits: _waits,
		...extras
	} = ctx;
	const initial: TaskState = {
		type: initialState,
		retries: 0,
		maxRetries: declared,
		cleared: [],
		classes,
		waits: 0,
		maxWaits,
	};
	// The Transitions mapped type demands a cell for every (state × msg) pair; a lane machine is
	// compiled from data and deliberately partial — the absent cells ARE the refusal contract
	// (`applyCell` throws `NoCellError` on them). One cast at the construction boundary.
	const machine = defineMachine<TaskState, LaneMsg, never, never, unknown>({
		init: (loaded) => [loaded ?? initial, []],
		update: table as never,
	});
	return {
		task: {
			machine,
			initial,
			finals,
			errorFinals,
			openFinals,
			guardedStates,
			waitParks,
			partialStates,
			staleGrants,
			extras,
		},
		defects: [],
	};
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
				readonly maxWaits: number;
				/** Per state, the events it holds a cell for — everything else refuses. */
				readonly states: Readonly<Record<string, ReadonlyArray<string>>>;
			}
		>
	>;
}

/**
 * The compiled machines summarized as data — what `lane print` answers with. Every state lists
 * {@link CLEARED_EVENT} because every state holds that cell; `maxRetries` is the declared budget,
 * which is what a fresh lane starts at before any grant is recorded.
 */
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
				maxWaits: task.initial.maxWaits,
				states: Object.fromEntries(
					Object.entries(task.machine.update as Record<string, Record<string, unknown>>).map(
						([state, cells]) => [state, Object.keys(cells)],
					),
				),
			},
		]),
	),
});
