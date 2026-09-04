/**
 * The shell's core: one Demlik machine holding workspaces, layouts, focus, per-window view state
 * and the prefix. Every Msg lands here and nothing else writes this state.
 *
 * Two shapes are worth naming before reading the cells.
 *
 * **A bound key runs its Msg, it does not queue one.** `keys.press` resolves a completed sequence
 * to the Msg that command names and applies it through this same reducer, in the transition that
 * read the key — so one press is one commit and one checkpoint. The name becomes a Msg through the
 * command table (`../commands/table.ts`), the one place that mapping lives, so a bound key and a
 * typed command line run the same row. A name the table does not hold — a user's own binding —
 * leaves as a `runCommand` Cmd for whoever runs the desk.
 *
 * **The prefix timer is the host's, and there is exactly one.** The core says when a window opens
 * (`startPrefixTimer`, carrying its length in ms) and when it closes (`cancelPrefixTimer`); the
 * host keeps one outstanding timer, replaces it on `startPrefixTimer` and drops it on
 * `cancelPrefixTimer`, then feeds `prefix.timeout` back when it fires. Without the cancel a timer
 * armed for a sequence that has since completed would disarm a prefix the user has just re-armed.
 */

import {defineMachine} from "@demlik/tea";
import {Duration} from "effect";
import {msgForCommandName} from "../commands/table.ts";
import type {CommandName, Key, PrefixState, PrefixTable} from "../keys/index.ts";
import {idle, route} from "../keys/index.ts";
import {
	createStack,
	createTree,
	createWindow,
	type Direction,
	findSibling,
	type Orientation,
	remove,
	setProcess,
	split,
	type WindowId,
} from "../layout/index.ts";
import type {ViewState} from "../window/host.ts";
import {
	activeWorkspace,
	disarmed,
	hasWindow,
	mint,
	type PrefixSnapshot,
	processOf,
	type ShellState,
	type Workspace,
	type WorkspaceId,
	windowIds,
	withActive,
	withoutViews,
} from "./state.ts";

/**
 * What the core asks its host to do. The absence is the point: there is no stop-a-process arm, so
 * closing a window cannot end the process it was showing — a window is a view onto a process, and
 * the last view closing says nothing about the process's lifetime.
 *
 * `openProgram` and `attachProcess` are the picker's (`../picker/open.ts` runs both): spawning
 * needs the registry and the process table, which a pure reducer cannot reach, so the core names
 * the window and the thing to show in it and stops there.
 */
export type ShellCmd =
	| {
			readonly type: "forwardKey";
			readonly processId: string;
			readonly windowId: WindowId;
			readonly key: string;
	  }
	| {readonly type: "startPrefixTimer"; readonly timeoutMs: number}
	| {readonly type: "cancelPrefixTimer"}
	| {readonly type: "runCommand"; readonly name: CommandName}
	| {readonly type: "openProgram"; readonly windowId: WindowId; readonly programId: string}
	| {readonly type: "attachProcess"; readonly windowId: WindowId; readonly processId: string}
	| {readonly type: "openCommandLine"}
	| {readonly type: "reloadConfig"};

/**
 * Every Msg the shell core takes. `windowId` and `workspaceId` are optional wherever the focused
 * window or the active workspace is the obvious subject; a Msg naming a window or workspace that
 * does not exist is a no-op, never a failure.
 *
 * `processId` is typed `string`: the kernel's `ProcessId`
 * ([`src/process/process.ts`](../../process/process.ts)) is a branded string and so assignable,
 * and the layout tree makes the same call for the same reason.
 */
export type ShellMsg =
	| {readonly type: "window.split"; readonly orientation: Orientation; readonly windowId?: WindowId}
	| {readonly type: "window.close"; readonly windowId?: WindowId}
	| {readonly type: "window.focus"; readonly windowId: WindowId}
	| {readonly type: "window.focusDirection"; readonly direction: Direction}
	| {readonly type: "window.bind"; readonly processId: string; readonly windowId?: WindowId}
	| {readonly type: "window.unbind"; readonly windowId?: WindowId}
	| {readonly type: "window.setView"; readonly view: ViewState; readonly windowId?: WindowId}
	| {readonly type: "workspace.create"}
	| {readonly type: "workspace.remove"; readonly workspaceId?: WorkspaceId}
	| {readonly type: "workspace.activate"; readonly workspaceId: WorkspaceId}
	| {readonly type: "workspace.step"; readonly direction: "previous" | "next"}
	| {readonly type: "window.open"; readonly programId: string; readonly windowId?: WindowId}
	| {readonly type: "window.attach"; readonly processId: string; readonly windowId?: WindowId}
	| {readonly type: "command.open"}
	| {readonly type: "config.reload"}
	| {readonly type: "keys.press"; readonly key: Key}
	| {readonly type: "prefix.timeout"};

/** What every cell returns: the state that follows, and what the host is asked to do. */
export type Step = readonly [ShellState, readonly ShellCmd[]];

const NO_CMDS: readonly ShellCmd[] = [];

/** One cell per Msg, each narrowed to its own Msg — the reducer form Demlik's `defineMachine` takes. */
export type ShellCells = {
	readonly [K in ShellMsg["type"]]: (
		state: ShellState,
		msg: Extract<ShellMsg, {readonly type: K}>,
	) => Step;
};

const emptyWorkspace = (id: WorkspaceId, stackId: string, windowId: WindowId): Workspace => ({
	id,
	layout: createTree(createStack(stackId, "horizontal", [createWindow(windowId)])),
	focused: windowId,
});

/** A fresh desk: one workspace, one empty window, the prefix unarmed. */
export const initialState = (): ShellState => {
	const ids = mint(0);
	return {
		workspaces: {[ids.workspace]: emptyWorkspace(ids.workspace, ids.stack, ids.window)},
		order: [ids.workspace],
		activeWorkspace: ids.workspace,
		views: {},
		prefix: disarmed,
		nextId: 1,
	};
};

const toRouter = (snapshot: PrefixSnapshot): PrefixState =>
	snapshot.armed
		? {_tag: "Armed", pending: snapshot.pending, timeout: Duration.millis(snapshot.timeoutMs)}
		: idle;

const fromRouter = (state: PrefixState): PrefixSnapshot =>
	state._tag === "Armed"
		? {armed: true, pending: state.pending, timeoutMs: Duration.toMillis(state.timeout)}
		: disarmed;

/** Opening a window replaces the outstanding timer; closing one drops it. Staying idle asks nothing. */
const timerCmds = (before: PrefixSnapshot, after: PrefixSnapshot): readonly ShellCmd[] => {
	if (after.armed) return [{type: "startPrefixTimer", timeoutMs: after.timeoutMs}];
	return before.armed ? [{type: "cancelPrefixTimer"}] : NO_CMDS;
};

/**
 * Attach or detach the process a window shows. Detaching is `null` and stops nothing: the process
 * runs on with no view, which is what makes a window a view rather than a container.
 */
const bindWindow = (
	state: ShellState,
	windowId: WindowId | undefined,
	processId: string | null,
): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = windowId ?? workspace.focused;
	if (!hasWindow(workspace, target)) return [state, NO_CMDS];
	return [
		withActive(state, {...workspace, layout: setProcess(workspace.layout, target, processId)}),
		NO_CMDS,
	];
};

const splitWindow = (state: ShellState, msg: Extract<ShellMsg, {type: "window.split"}>): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = msg.windowId ?? workspace.focused;
	if (!hasWindow(workspace, target)) return [state, NO_CMDS];

	const ids = mint(state.nextId);
	const layout = split(workspace.layout, target, msg.orientation, {
		window: ids.window,
		stack: ids.stack,
	});
	if (layout === workspace.layout) return [state, NO_CMDS];

	// The new window is empty and takes focus: a split is how the user asks for somewhere to work.
	return [
		{
			...withActive(state, {...workspace, layout, focused: ids.window}),
			nextId: state.nextId + 1,
		},
		NO_CMDS,
	];
};

/**
 * Close a window. The last window of a workspace stays: a workspace with no window has no layout
 * tree to render and no focus to hold, the same reason the last workspace cannot be removed. No
 * Cmd is emitted either way — a process outlives every window that showed it.
 */
const closeWindow = (state: ShellState, msg: Extract<ShellMsg, {type: "window.close"}>): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = msg.windowId ?? workspace.focused;
	const ids = windowIds(workspace);
	const at = ids.indexOf(target);
	if (at === -1 || ids.length === 1) return [state, NO_CMDS];

	const heir = ids[at + 1] ?? ids[at - 1];
	if (heir === undefined) return [state, NO_CMDS];
	return [
		{
			...withActive(state, {
				...workspace,
				layout: remove(workspace.layout, target),
				focused: workspace.focused === target ? heir : workspace.focused,
			}),
			views: withoutViews(state.views, [target]),
		},
		NO_CMDS,
	];
};

const focusWindow = (state: ShellState, windowId: WindowId): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined || !hasWindow(workspace, windowId)) return [state, NO_CMDS];
	return [withActive(state, {...workspace, focused: windowId}), NO_CMDS];
};

const focusDirection = (state: ShellState, direction: Direction): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const neighbour = findSibling(workspace.layout, workspace.focused, direction);
	// No neighbour on that side: focus stays where it is rather than wrapping to the far edge.
	return neighbour === null ? [state, NO_CMDS] : focusWindow(state, neighbour.id);
};

const setView = (state: ShellState, msg: Extract<ShellMsg, {type: "window.setView"}>): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = msg.windowId ?? workspace.focused;
	if (!hasWindow(workspace, target)) return [state, NO_CMDS];
	return [{...state, views: {...state.views, [target]: msg.view}}, NO_CMDS];
};

const createWorkspace = (state: ShellState): Step => {
	const ids = mint(state.nextId);
	return [
		{
			...state,
			workspaces: {
				...state.workspaces,
				[ids.workspace]: emptyWorkspace(ids.workspace, ids.stack, ids.window),
			},
			order: [...state.order, ids.workspace],
			// Studio's `addWorkspace` activates what it just made; a new desk is one the user asked for.
			activeWorkspace: ids.workspace,
			nextId: state.nextId + 1,
		},
		NO_CMDS,
	];
};

/**
 * Remove a workspace and activate the nearest one — the next in creation order, else the previous.
 * The last workspace is never removed: a shell with no desk has nothing to show and no id to make
 * active. Studio's `removeWorkspace` refuses the same case; its neighbour walk is what this is.
 */
const removeWorkspace = (
	state: ShellState,
	msg: Extract<ShellMsg, {type: "workspace.remove"}>,
): Step => {
	const target = msg.workspaceId ?? state.activeWorkspace;
	const at = state.order.indexOf(target);
	if (at === -1 || state.order.length === 1) return [state, NO_CMDS];

	const doomed = state.workspaces[target];
	const order = state.order.filter((id) => id !== target);
	const workspaces: Record<WorkspaceId, Workspace> = {};
	for (const id of order) {
		const workspace = state.workspaces[id];
		if (workspace !== undefined) workspaces[id] = workspace;
	}

	const heir = state.order[at + 1] ?? state.order[at - 1];
	return [
		{
			...state,
			workspaces,
			order,
			activeWorkspace:
				state.activeWorkspace === target ? (heir ?? state.activeWorkspace) : state.activeWorkspace,
			views: withoutViews(state.views, doomed === undefined ? [] : windowIds(doomed)),
		},
		NO_CMDS,
	];
};

/** Walking workspaces wraps, as tmux's `next-window` does. */
const neighbourWorkspace = (state: ShellState, step: number): Step => {
	const at = state.order.indexOf(state.activeWorkspace);
	if (at === -1 || state.order.length === 0) return [state, NO_CMDS];
	const next = state.order[(at + step + state.order.length) % state.order.length];
	return next === undefined ? [state, NO_CMDS] : [{...state, activeWorkspace: next}, NO_CMDS];
};

/**
 * Name the window a Cmd targets, when the desk has one. Both picker arms below take it the same
 * way every other cell does — the Msg's own window, else the focused one — and a Msg naming a
 * window this workspace does not hold is a no-op rather than a failure.
 */
const targetWindow = (state: ShellState, windowId: WindowId | undefined): WindowId | null => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return null;
	const target = windowId ?? workspace.focused;
	return hasWindow(workspace, target) ? target : null;
};

/**
 * The cells, closed over the table the key router reads. A table is configuration, not state: it
 * holds `Duration.Duration` values, and the shell's state is checkpointed JSON.
 */
export const cellsFor = (table: PrefixTable): ShellCells => {
	const apply = (state: ShellState, msg: ShellMsg): Step => runCell(cells, state, msg);

	const pressKey = (state: ShellState, msg: Extract<ShellMsg, {type: "keys.press"}>): Step => {
		const answer = route(table, toRouter(state.prefix), msg.key);
		const prefix = fromRouter(answer.next);
		const timer = timerCmds(state.prefix, prefix);
		const routed: ShellState = {...state, prefix};

		if (answer._tag === "ToWindow") {
			const workspace = activeWorkspace(routed);
			const processId = workspace === undefined ? null : processOf(workspace, workspace.focused);
			// An empty window has no process to forward to, so the key is dropped rather than queued.
			return [
				routed,
				processId === null || workspace === undefined
					? timer
					: [
							...timer,
							{
								type: "forwardKey",
								processId,
								windowId: workspace.focused,
								key: answer.key,
							},
						],
			];
		}

		if (answer._tag !== "Command") return [routed, timer];

		// The command table is the one place a name becomes a Msg, so a bound key and a typed line
		// run the same row. A name it does not hold — or a row needing an argument a key sequence
		// has nowhere to carry — leaves as a `runCommand` Cmd for a surface to answer.
		const commanded = msgForCommandName(answer.name);
		if (commanded === null) return [routed, [...timer, {type: "runCommand", name: answer.name}]];
		const [next, cmds] = apply(routed, commanded);
		return [next, [...timer, ...cmds]];
	};

	const cells: ShellCells = {
		"window.split": splitWindow,
		"window.close": closeWindow,
		"window.focus": (state, msg) => focusWindow(state, msg.windowId),
		"window.focusDirection": (state, msg) => focusDirection(state, msg.direction),
		"window.bind": (state, msg) => bindWindow(state, msg.windowId, msg.processId),
		"window.unbind": (state, msg) => bindWindow(state, msg.windowId, null),
		"window.setView": setView,
		"workspace.create": createWorkspace,
		"workspace.remove": removeWorkspace,
		"workspace.activate": (state, msg) => {
			const known = state.order.includes(msg.workspaceId);
			return known ? [{...state, activeWorkspace: msg.workspaceId}, NO_CMDS] : [state, NO_CMDS];
		},
		"workspace.step": (state, msg) => neighbourWorkspace(state, msg.direction === "next" ? 1 : -1),
		"window.open": (state, msg) => {
			const target = targetWindow(state, msg.windowId);
			return target === null
				? [state, NO_CMDS]
				: [state, [{type: "openProgram", windowId: target, programId: msg.programId}]];
		},
		"window.attach": (state, msg) => {
			const target = targetWindow(state, msg.windowId);
			return target === null
				? [state, NO_CMDS]
				: [state, [{type: "attachProcess", windowId: target, processId: msg.processId}]];
		},
		// Neither touches the desk, and neither leaves as `runCommand`: a host answering that Cmd
		// resolves the name through the command table, so routing a row's own Msg back through it
		// would be a loop. Each gets the arm that says what it is.
		"command.open": (state) => [state, [{type: "openCommandLine"}]],
		"config.reload": (state) => [state, [{type: "reloadConfig"}]],
		"keys.press": pressKey,
		"prefix.timeout": (state) =>
			state.prefix.armed ? [{...state, prefix: disarmed}, NO_CMDS] : [state, NO_CMDS],
	};

	return cells;
};

/**
 * TypeScript cannot narrow `cells[msg.type]` against `msg` through a computed key. `ShellCells` is
 * what keeps a cell paired with its own Msg; this is the one place that pairing is asserted rather
 * than checked, and it is why no cell may be added outside the `ShellCells` type.
 */
const runCell = (cells: ShellCells, state: ShellState, msg: ShellMsg): Step =>
	(cells[msg.type] as (state: ShellState, msg: ShellMsg) => Step)(state, msg);

/**
 * Run one Msg through the cells without a runtime — what the tests drive, and the shape the shell
 * program (#7558) folds when it replays a checkpoint.
 */
export const applyMsg = (table: PrefixTable, state: ShellState, msg: ShellMsg): Step =>
	runCell(cellsFor(table), state, msg);

export interface ShellCoreOptions {
	/** The grammar `keys.press` routes against — configuration, never state (it holds `Duration`s). */
	readonly table: PrefixTable;
}

/** The shell's core machine. One `defineMachine`; the registry row that carries it lands with #7558. */
export const shellCore = ({table}: ShellCoreOptions) =>
	defineMachine<ShellState, ShellMsg, ShellCmd, never, unknown>({
		init: (loaded) => [loaded ?? initialState(), []],
		update: cellsFor(table),
		// Demlik's `Machine` demands a Promise `interpret` beside the row's own handlers; the host
		// never reads it (#7576). The shell's Effect handlers land with its registry row (#7558).
		interpret: {
			forwardKey: () => Promise.resolve(),
			startPrefixTimer: () => Promise.resolve(),
			cancelPrefixTimer: () => Promise.resolve(),
			runCommand: () => Promise.resolve(),
			openProgram: () => Promise.resolve(),
			attachProcess: () => Promise.resolve(),
			openCommandLine: () => Promise.resolve(),
			reloadConfig: () => Promise.resolve(),
		},
	});
