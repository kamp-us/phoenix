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
 * **The only timer is the repeat window's, and there is exactly one.** An armed prefix waits
 * indefinitely, as tmux does (#7842), so nothing here dates a plain arm. tmux's `repeat-time` is
 * still bounded: after a `repeatable: true` binding the core asks for `startRepeatTimer` carrying
 * that window's length in ms, and `cancelRepeatTimer` when it closes; the host keeps one
 * outstanding timer and feeds `prefix.repeatLapsed` back when it fires. Without the cancel a timer
 * left over from a spent repeat window would disarm a prefix the user has since re-armed.
 */

import {defineMachine} from "@demlik/tea";
import {Duration} from "effect";
import {msgForCommandName} from "../commands/table.ts";
import {type DeskMsg, initialDesk, toggleInspector} from "../desk/state.ts";
import type {CommandName, Key, PrefixState, PrefixTable, RouteAnswer} from "../keys/index.ts";
import {idle, route} from "../keys/index.ts";
import {
	createStack,
	createTree,
	createWindow,
	type Direction,
	findSibling,
	type NodeId,
	type Orientation,
	remove,
	resize,
	type StackId,
	setProcess,
	split,
	unzoom,
	type WindowId,
	zoom,
} from "../layout/index.ts";
import type {OpenSession} from "../picker/intent.ts";
import {mountPicker} from "../picker/view.ts";
import type {ViewState} from "../window/host.ts";
import {
	activeWorkspace,
	disarmed,
	hasWindow,
	type KeyOutcome,
	keyTargetOf,
	type LastPress,
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
 * The arms the kernel's own `HostHandlers` answer (`../host/effects.ts`). `openProgram` and
 * `attachProcess` are the picker's (`../picker/open.ts` runs both): spawning needs the registry and
 * the process table, which a pure reducer cannot reach, so the core names the window and the thing
 * to show in it and stops there. Each carries the window's view slot as well, because a refusal
 * leaves that handler as a `window.setView` written back over it, and the slot is state only the
 * core can read — a refusal handed no slot is the one that throws away the picker's `previous`
 * (#8265). `forwardKey` is here too — a key belongs to the focused window's
 * *process*, and delivering it is a dispatch into that process. `runCommand` and `reloadConfig`
 * have no runner yet and are still the kernel's: resolving a name the command table does not hold
 * needs the spell registry, and `Booted.reload` sits above the kernel (#7743).
 */
export type KernelCmd =
	| {
			readonly type: "forwardKey";
			readonly processId: string;
			readonly windowId: WindowId;
			readonly key: string;
	  }
	| {readonly type: "runCommand"; readonly name: CommandName}
	| {
			readonly type: "openProgram";
			readonly windowId: WindowId;
			readonly programId: string;
			readonly session?: OpenSession;
			readonly view?: ViewState;
	  }
	| {
			readonly type: "attachProcess";
			readonly windowId: WindowId;
			readonly processId: string;
			readonly view?: ViewState;
	  }
	| {readonly type: "reloadConfig"};

/**
 * The arms no kernel handler can answer, which the browser surface answers instead: the command
 * line is a page element, and a handler returns its follow-up Msgs rather than holding a dispatcher
 * it could fire a timer through. Cmds do not cross the transport, so the page learns about these
 * from state instead: the countdown off the prefix the snapshot carries, and the command line off
 * the answer this fold records on `lastPress` (#8274, `../ui/press.ts`). It does not route a key of
 * its own to derive them ([ADR 0353](../../../../../.decisions/0353-kernel-sends-the-prefix-table.md)).
 */
export type PageCmd =
	| {readonly type: "startRepeatTimer"; readonly timeoutMs: number}
	| {readonly type: "cancelRepeatTimer"}
	| {readonly type: "openCommandLine"};

/**
 * What the core asks its host to do, as the two halves that answer it. The absence is the point:
 * there is no stop-a-process arm, so closing a window cannot end the process it was showing — a
 * window is a view onto a process, and the last view closing says nothing about the process's
 * lifetime. A ninth arm joins `KernelCmd` or `PageCmd`; there is nowhere else to put one.
 */
export type ShellCmd = KernelCmd | PageCmd;

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
	| {
			readonly type: "window.bind";
			readonly processId: string;
			readonly windowId?: WindowId;
			/**
			 * The bound program declared `takesKeys`. The picker reads it off the row it just resolved
			 * (`../picker/open.ts`); absent means the shell forwards this window no keys (#7973).
			 */
			readonly takesKeys?: boolean;
	  }
	| {readonly type: "window.unbind"; readonly windowId?: WindowId}
	| {
			/**
			 * Hand this key to the focused window as if it had been pressed there. The Msg knows
			 * nothing about what any window does with it: a window that draws no list for
			 * `FOCUS_LIST_KEY` ignores it, exactly as a process with no `key` cell does (#8407).
			 */
			readonly type: "window.forwardKey";
			readonly key: string;
	  }
	| {readonly type: "window.setView"; readonly view: ViewState; readonly windowId?: WindowId}
	| {
			readonly type: "layout.resize";
			readonly stackId: StackId;
			readonly sizes: Readonly<Record<NodeId, number>>;
	  }
	| {readonly type: "layout.zoom"; readonly windowId?: WindowId}
	| {readonly type: "workspace.create"}
	| {readonly type: "workspace.remove"; readonly workspaceId?: WorkspaceId}
	| {readonly type: "workspace.activate"; readonly workspaceId: WorkspaceId}
	| {readonly type: "workspace.step"; readonly direction: "previous" | "next"}
	| {
			readonly type: "window.open";
			readonly programId: string;
			readonly windowId?: WindowId;
			/** The session this open is for, when it is for one (`../picker/intent.ts`). */
			readonly session?: OpenSession;
	  }
	| {readonly type: "window.attach"; readonly processId: string; readonly windowId?: WindowId}
	| {readonly type: "command.open"}
	| {readonly type: "config.reload"}
	| {
			readonly type: "keys.press";
			readonly key: Key;
			/**
			 * The presser's own stamp, echoed back on `lastPress` so the answer to this key is
			 * readable as this presser's and nobody else's (#8274). Optional: a key pressed by
			 * something that will not read the answer — a test, a kernel-side caller — sends none.
			 */
			readonly pressId?: string;
	  }
	| {readonly type: "prefix.repeatLapsed"}
	| DeskMsg;

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
		desk: initialDesk,
		prefix: disarmed,
		nextId: 1,
	};
};

const toRouter = (snapshot: PrefixSnapshot): PrefixState =>
	snapshot.armed
		? {
				_tag: "Armed",
				pending: snapshot.pending,
				repeatWindow:
					snapshot.repeatWindowMs === null ? null : Duration.millis(snapshot.repeatWindowMs),
			}
		: idle;

const fromRouter = (state: PrefixState): PrefixSnapshot =>
	state._tag === "Armed"
		? {
				armed: true,
				pending: state.pending,
				repeatWindowMs: state.repeatWindow === null ? null : Duration.toMillis(state.repeatWindow),
			}
		: disarmed;

const outcomeOf = (answer: RouteAnswer): KeyOutcome => {
	if (answer._tag === "ToWindow") return {_tag: "ToWindow", key: answer.key};
	if (answer._tag === "Command") return {_tag: "Command", name: String(answer.name)};
	return {_tag: "Consumed"};
};

/**
 * The answer, stamped with the presser's id. An unstamped press records the empty string, which no
 * presser mints, so nothing can read the answer to somebody else's key as its own.
 */
const recorded = (
	msg: Extract<ShellMsg, {type: "keys.press"}>,
	answer: RouteAnswer,
): LastPress => ({pressId: msg.pressId ?? "", outcome: outcomeOf(answer)});

/** How long the prefix's repeat window has left to run, or `null` when it is not in one. */
const repeatWindowOf = (snapshot: PrefixSnapshot): number | null =>
	snapshot.armed ? snapshot.repeatWindowMs : null;

/**
 * Opening a repeat window replaces the outstanding timer; leaving one drops it. A plain arm asks
 * for neither, which is what makes waiting forever the shape rather than a large number.
 */
const timerCmds = (before: PrefixSnapshot, after: PrefixSnapshot): readonly ShellCmd[] => {
	const window = repeatWindowOf(after);
	if (window !== null) return [{type: "startRepeatTimer", timeoutMs: window}];
	return repeatWindowOf(before) === null ? NO_CMDS : [{type: "cancelRepeatTimer"}];
};

/**
 * Attach or detach the process a window shows. Detaching is `null` and stops nothing: the process
 * runs on with no view, which is what makes a window a view rather than a container.
 *
 * The view slot goes with the binding either way. A slot belongs to whatever the window is showing,
 * and the newly bound program did not write the one that is there — which is also what keeps a
 * `previous` from outliving the picker that recorded it (#8265).
 */
const bindWindow = (
	state: ShellState,
	windowId: WindowId | undefined,
	processId: string | null,
	takesKeys = false,
): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = windowId ?? workspace.focused;
	if (!hasWindow(workspace, target)) return [state, NO_CMDS];
	return [
		{
			...withActive(state, {
				...workspace,
				layout: setProcess(workspace.layout, target, processId, takesKeys),
			}),
			views: withoutViews(state.views, [target]),
		},
		NO_CMDS,
	];
};

/**
 * Put a window back on the picker: detach its process, which stops nothing, and mount a fresh
 * picker view naming the process it was showing, so Escape has somewhere to return to and the
 * highlight starts on that row (`../picker/view.ts`). The mount is fresh rather than the cursor and
 * refusal the last one left behind (`../ui/PickerView.tsx` rebuilds the picker's view from it).
 *
 * A window holding no process is left untouched rather than cleared. It is already showing the
 * picker, and dropping the slot there would move the user's highlight back to the first row under
 * their hands — a key that should have done nothing at all.
 */
const unbindWindow = (state: ShellState, windowId: WindowId | undefined): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const target = windowId ?? workspace.focused;
	if (!hasWindow(workspace, target)) return [state, NO_CMDS];
	const showing = processOf(workspace, target);
	if (showing === null) return [state, NO_CMDS];
	const [detached] = bindWindow(state, target, null);
	return [{...detached, views: {...detached.views, [target]: mountPicker(showing)}}, NO_CMDS];
};

/**
 * Write one stack's sizes. The surface sends this once per finished drag and never per pointer
 * move: a Msg per move checkpoints a hundred times across one gesture and mirrors half-finished
 * layouts to every other tab ([`.patterns/layout-tree-with-resizable-panels.md`](../../../../../.patterns/layout-tree-with-resizable-panels.md)).
 */
const resizeStack = (state: ShellState, msg: Extract<ShellMsg, {type: "layout.resize"}>): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const layout = resize(workspace.layout, msg.stackId, msg.sizes);
	return layout === workspace.layout
		? [state, NO_CMDS]
		: [withActive(state, {...workspace, layout}), NO_CMDS];
};

/**
 * Toggle zoom, tmux's `prefix z`. Zooming while a window is already zoomed unzooms whichever it
 * was, so one key is the whole gesture; `sizes` is never written either way, which is what makes
 * unzoom restore the split exactly (`../layout/tree.ts`).
 */
const zoomWindow = (state: ShellState, msg: Extract<ShellMsg, {type: "layout.zoom"}>): Step => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) return [state, NO_CMDS];
	const layout =
		workspace.layout.zoomed === null
			? zoom(workspace.layout, msg.windowId ?? workspace.focused)
			: unzoom(workspace.layout);
	return layout === workspace.layout
		? [state, NO_CMDS]
		: [withActive(state, {...workspace, layout}), NO_CMDS];
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
 * One window's view slot as a Cmd field, spread rather than assigned so a window holding no slot
 * sends no `view` key at all — the field is optional and `exactOptionalPropertyTypes` reads an
 * explicit `undefined` as a different thing from an absent one.
 */
const viewOf = (state: ShellState, windowId: WindowId): {readonly view?: ViewState} => {
	const view = state.views[windowId];
	return view === undefined ? {} : {view};
};

/**
 * The cells, closed over the table the key router reads. A table is configuration, not state: it
 * holds `Duration.Duration` values, and the shell's state is checkpointed JSON.
 */
export const cellsFor = (table: PrefixTable): ShellCells => {
	const apply = (state: ShellState, msg: ShellMsg): Step => runCell(cells, state, msg);

	/**
	 * Hand one key to the focused window, both halves of what that means: the Cmd that delivers it
	 * into the window's *process*, and the `ToWindow` answer the page reads to deliver it into the
	 * window's *renderer* (`../ui/press.ts`). They reach two different places, and the renderer is
	 * the one where a list's focus lives — which is why an empty window, whose program has no
	 * process to forward to, still forwards to whatever is drawn in it (the picker).
	 *
	 * `window.forwardKey` runs this too, and that is what lets a bound chord reach a renderer no
	 * command name can address: the binding names a command, the command mints a key, and this
	 * writes the same answer an unbound press of that key would have written (#8407).
	 */
	const toFocusedWindow = (state: ShellState, key: string): Step => {
		const workspace = activeWorkspace(state);
		const next: ShellState =
			state.lastPress === undefined
				? state
				: {...state, lastPress: {...state.lastPress, outcome: {_tag: "ToWindow", key}}};
		// An empty window has no process to forward to, and a window whose program never declared
		// `takesKeys` has no cell for one, so the key is dropped rather than queued (#7973).
		const processId = workspace === undefined ? null : keyTargetOf(workspace, workspace.focused);
		return [
			next,
			processId === null || workspace === undefined
				? NO_CMDS
				: [{type: "forwardKey", processId, windowId: workspace.focused, key}],
		];
	};

	const pressKey = (state: ShellState, msg: Extract<ShellMsg, {type: "keys.press"}>): Step => {
		const answer = route(table, toRouter(state.prefix), msg.key);
		const prefix = fromRouter(answer.next);
		const timer = timerCmds(state.prefix, prefix);
		// The answer is written into state rather than only spent as Cmds, because Cmds are the
		// kernel's and no Cmd crosses the transport: this field is how the page learns what the one
		// router decided about the key it sent (#8274, `../ui/Desk.tsx`).
		const routed: ShellState = {...state, prefix, lastPress: recorded(msg, answer)};

		if (answer._tag === "ToWindow") {
			const [next, cmds] = toFocusedWindow(routed, answer.key);
			return [next, [...timer, ...cmds]];
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
		"window.bind": (state, msg) => bindWindow(state, msg.windowId, msg.processId, msg.takesKeys),
		"window.unbind": (state, msg) => unbindWindow(state, msg.windowId),
		"window.forwardKey": (state, msg) => toFocusedWindow(state, msg.key),
		"window.setView": setView,
		"layout.resize": resizeStack,
		"layout.zoom": zoomWindow,
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
				: [
						state,
						[
							{
								type: "openProgram",
								windowId: target,
								programId: msg.programId,
								...(msg.session === undefined ? {} : {session: msg.session}),
								...viewOf(state, target),
							},
						],
					];
		},
		"window.attach": (state, msg) => {
			const target = targetWindow(state, msg.windowId);
			return target === null
				? [state, NO_CMDS]
				: [
						state,
						[
							{
								type: "attachProcess",
								windowId: target,
								processId: msg.processId,
								...viewOf(state, target),
							},
						],
					];
		},
		// Neither touches the desk, and neither leaves as `runCommand`: a host answering that Cmd
		// resolves the name through the command table, so routing a row's own Msg back through it
		// would be a loop. Each gets the arm that says what it is.
		"command.open": (state) => [state, [{type: "openCommandLine"}]],
		"config.reload": (state) => [state, [{type: "reloadConfig"}]],
		// Desk-level, so every workspace cell above leaves it untouched by spreading `...state`.
		"desk.inspector.toggle": (state) => [{...state, desk: toggleInspector(state.desk)}, NO_CMDS],
		"keys.press": pressKey,
		// A lapse disarms a repeat window and nothing else: a timer left over from a spent window
		// must not drop a prefix the user has since armed by hand, which waits indefinitely.
		"prefix.repeatLapsed": (state) =>
			state.prefix.armed && state.prefix.repeatWindowMs !== null
				? [{...state, prefix: disarmed}, NO_CMDS]
				: [state, NO_CMDS],
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
			startRepeatTimer: () => Promise.resolve(),
			cancelRepeatTimer: () => Promise.resolve(),
			runCommand: () => Promise.resolve(),
			openProgram: () => Promise.resolve(),
			attachProcess: () => Promise.resolve(),
			openCommandLine: () => Promise.resolve(),
			reloadConfig: () => Promise.resolve(),
		},
	});
