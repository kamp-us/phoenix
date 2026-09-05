/**
 * What the browser surface renders, as data — the same shape `../picker/frame.ts` takes for the
 * picker, and for the same reason: everything the page decides is decided here, in a pure function
 * a test drives with no DOM, and the components below bind the answer to elements verbatim.
 *
 * One thing here looks like duplication and is not. `surfaceKey` runs the shell's own `route`
 * (`../keys/router.ts`) a second time, on the page, over the prefix snapshot the kernel sent. The
 * core runs it too and answers with Cmds — but Cmds are the kernel's, and the transport carries no
 * Cmd frame (`../transport/wire.ts`): a page learns state, never instructions. So the two effects
 * a *surface* owns — opening the command line and forwarding a key into the focused window's
 * renderer — have to be derived here. They cannot disagree with the core, because both call the one
 * pure `route` over the one `PrefixTable` — an argument, not a guard, which is
 * [#7781](https://github.com/kamp-us/phoenix/issues/7781).
 */

import {Duration} from "effect";
import type {ShellState, Workspace} from "../core/index.ts";
import {activeWorkspace} from "../core/index.ts";
import type {CommandName, Key, PrefixState, PrefixTable} from "../keys/index.ts";
import {idle, route} from "../keys/index.ts";
import type {LayoutNode, WindowId as LayoutWindowId, NodeId, StackNode} from "../layout/index.ts";
import {WindowId} from "../window/index.ts";

/** The command name the surface, not the kernel, answers: opening the command line is a page act. */
export const COMMAND_LINE_COMMAND = "command:open";

/** The prefix snapshot as the router takes it — the inverse of the core's own `fromRouter`. */
export const routerPrefix = (state: ShellState): PrefixState =>
	state.prefix.armed
		? {
				_tag: "Armed",
				pending: state.prefix.pending,
				timeout: Duration.millis(state.prefix.timeoutMs),
			}
		: idle;

/**
 * What the *surface* must do about one key, beside always dispatching `keys.press`. Three arms and
 * no fourth: a key either opens the command line, belongs to the focused window's renderer, or is
 * the shell's own business and nothing the page does about it.
 */
export type SurfaceKeyAnswer =
	| {readonly _tag: "OpenCommandLine"}
	| {readonly _tag: "ToWindow"; readonly key: string}
	/** A named command the page does not implement, or an armed/pending/unbound prefix. */
	| {readonly _tag: "Shell"; readonly command: CommandName | null};

export const surfaceKey = (
	table: PrefixTable,
	prefix: PrefixState,
	event: Key,
): SurfaceKeyAnswer => {
	const answer = route(table, prefix, event);
	if (answer._tag === "ToWindow") return {_tag: "ToWindow", key: answer.key};
	if (answer._tag === "Command") {
		return String(answer.name) === COMMAND_LINE_COMMAND
			? {_tag: "OpenCommandLine"}
			: {_tag: "Shell", command: answer.name};
	}
	return {_tag: "Shell", command: null};
};

/** The status line, as text. Every field is read off the snapshot; the page stores none of it. */
export interface StatusFrame {
	readonly workspace: string;
	/** Which of the desk's workspaces this is, one-based, and how many there are. */
	readonly position: {readonly at: number; readonly of: number};
	readonly prefixArmed: boolean;
	/** The sequence typed since the prefix armed. Empty while armed with nothing typed yet. */
	readonly pending: ReadonlyArray<string>;
	readonly windowCount: number;
	readonly zoomed: boolean;
	/** What a reader is told when the prefix is armed — never the armed colour alone (Pillar 4). */
	readonly announcement: string;
}

export const statusFrame = (state: ShellState): StatusFrame => {
	const workspace = activeWorkspace(state);
	const at = state.order.indexOf(state.activeWorkspace);
	const pending = state.prefix.armed ? state.prefix.pending : [];
	return {
		workspace: state.activeWorkspace,
		position: {at: at === -1 ? 0 : at + 1, of: state.order.length},
		prefixArmed: state.prefix.armed,
		pending,
		windowCount: workspace === undefined ? 0 : [...panelWindows(workspace.layout.root)].length,
		zoomed: workspace?.layout.zoomed != null,
		announcement: state.prefix.armed
			? pending.length === 0
				? "Prefix armed, waiting for a sequence."
				: `Prefix armed, pending ${pending.join("")}.`
			: "Prefix idle.",
	};
};

/** Every window of a node, in reading order. A local walk so this module imports no tree writer. */
export function* panelWindows(node: LayoutNode): Generator<LayoutWindowId> {
	if (node.tag === "window") {
		yield node.id;
		return;
	}
	for (const child of node.children) yield* panelWindows(child);
}

/**
 * One stack's sizes as `react-resizable-panels` takes them: a map of `Panel.id` to percent. Keyed
 * by the child's own node id, never by its position — a positional key silently re-points every
 * stored size when a sibling splits (`.patterns/layout-tree-with-resizable-panels.md`).
 */
export const defaultLayoutOf = (stack: StackNode): Record<string, number> => {
	const layout: Record<string, number> = {};
	for (const child of stack.children) {
		const size = stack.sizes[child.id];
		if (size !== undefined) layout[child.id] = size;
	}
	return layout;
};

/**
 * Does the group already hold exactly this stack's children as panels? A `setLayout` naming any
 * other set throws rather than no-ops, and one gesture — a split or a close — leaves the two out of
 * step for a commit (`.patterns/layout-tree-with-resizable-panels.md`, Rule 2).
 */
export const holdsPanels = (
	stack: StackNode,
	reported: Readonly<Record<NodeId, number>>,
): boolean =>
	Object.keys(reported).length === stack.children.length &&
	stack.children.every((child) => reported[child.id] !== undefined);

/**
 * Is the layout the library reports the one the tree already holds? Compared per key against the
 * tree's own tolerance, because a released drag reports percentages the browser rounded and an
 * equality test on raw floats would call every mirror a change and loop.
 *
 * Sizes only — the panel set is `holdsPanels`'s question, and the two are asked in that order.
 */
export const sameLayout = (
	stack: StackNode,
	reported: Readonly<Record<NodeId, number>>,
	tolerance: number,
): boolean =>
	stack.children.every((child) => {
		const next = reported[child.id];
		const held = stack.sizes[child.id];
		return next === undefined || held === undefined || Math.abs(next - held) <= tolerance;
	});

/** The window a zoomed workspace renders alone, or `null`. `zoomed` naming no window is not zoomed. */
export const zoomedWindow = (workspace: Workspace): WindowId | null => {
	const zoomed = workspace.layout.zoomed;
	if (zoomed === null) return null;
	for (const windowId of panelWindows(workspace.layout.root)) {
		if (windowId === zoomed) return WindowId.make(zoomed);
	}
	return null;
};
