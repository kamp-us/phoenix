/**
 * What the browser surface renders, as data — the same shape `../picker/frame.ts` takes for the
 * picker, and for the same reason: everything the page decides is decided here, in a pure function
 * a test drives with no DOM, and the components below bind the answer to elements verbatim.
 *
 * One thing here looks like duplication and is not. `surfaceKey` runs the shell's own `route`
 * (`../keys/router.ts`) a second time, on the page, over the prefix the page holds — the snapshot
 * the kernel sent, advanced by the page's own presses since (`./Desk.tsx`, #8274). The
 * core runs it too and answers with Cmds — but Cmds are the kernel's, and the transport carries no
 * Cmd frame (`../transport/wire.ts`): a page learns state, never instructions. So the two effects
 * a *surface* owns — opening the command line and forwarding a key into the focused window's
 * renderer — are derived here, deliberately
 * ([ADR 0353](../../../../../.decisions/0353-kernel-sends-the-prefix-table.md)). Both sides call
 * the one pure `route`, and the `PrefixTable` they call it over is one table because the kernel
 * sends it; that they answer alike is held by `./key-agreement.unit.test.ts`, not by argument.
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
				repeatWindow:
					state.prefix.repeatWindowMs === null
						? null
						: Duration.millis(state.prefix.repeatWindowMs),
			}
		: idle;

/** The repeat window a prefix state is inside, in milliseconds, or `null` when it is in none. */
export const repeatWindowOf = (prefix: PrefixState): number | null =>
	prefix._tag === "Armed" && prefix.repeatWindow !== null
		? Duration.toMillis(prefix.repeatWindow)
		: null;

/**
 * Do two prefix states say the same thing? Value equality and never identity: a snapshot arrives
 * JSON-decoded, so the kernel's prefix is a new object on every frame, and only its value can
 * answer whether the kernel has caught up with the prefix the page advanced itself (#8274).
 */
export const samePrefix = (a: PrefixState, b: PrefixState): boolean => {
	if (a._tag === "Idle" || b._tag === "Idle") return a._tag === b._tag;
	return (
		a.pending.length === b.pending.length &&
		a.pending.every((key, index) => b.pending[index] === key) &&
		repeatWindowOf(a) === repeatWindowOf(b)
	);
};

/**
 * What the *surface* must do about one key, beside always dispatching `keys.press`. Three arms and
 * no fourth: a key either opens the command line, belongs to the focused window's renderer, or is
 * the shell's own business and nothing the page does about it.
 *
 * Every arm carries `next`, the prefix state that follows this key, straight off `route`. The page
 * routes the next key of a sequence over it rather than over the snapshot, so two keys typed inside
 * one kernel round trip fold through the same pure function from the same start on both sides
 * (#8274).
 */
export type SurfaceKeyAnswer =
	| {readonly _tag: "OpenCommandLine"; readonly next: PrefixState}
	| {readonly _tag: "ToWindow"; readonly key: string; readonly next: PrefixState}
	/** A named command the page does not implement, or an armed/pending/unbound prefix. */
	| {readonly _tag: "Shell"; readonly command: CommandName | null; readonly next: PrefixState};

/**
 * Is this key the shell's, whatever holds DOM focus? tmux's rule, and the whole of #8270: the
 * prefix is the one key a pane never gets, and once it is armed every key of the sequence is the
 * shell's too. Everything else typed into a text entry belongs to the text entry.
 *
 * Asked of the same `route` the surface routes with, so the two can never disagree about which key
 * arms the prefix — a second reading of `table.prefix` here is how that drift starts.
 */
export const shellOwnsKey = (table: PrefixTable, prefix: PrefixState, event: Key): boolean =>
	prefix._tag === "Armed" || route(table, prefix, event)._tag === "Arm";

export const surfaceKey = (
	table: PrefixTable,
	prefix: PrefixState,
	event: Key,
): SurfaceKeyAnswer => {
	const answer = route(table, prefix, event);
	if (answer._tag === "ToWindow") return {_tag: "ToWindow", key: answer.key, next: answer.next};
	if (answer._tag === "Command") {
		return String(answer.name) === COMMAND_LINE_COMMAND
			? {_tag: "OpenCommandLine", next: answer.next}
			: {_tag: "Shell", command: answer.name, next: answer.next};
	}
	return {_tag: "Shell", command: null, next: answer.next};
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
