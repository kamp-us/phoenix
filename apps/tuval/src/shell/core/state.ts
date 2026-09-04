/**
 * The shell core's state and the pure readers over it. Everything here is JSON: the shell
 * checkpoints through the kernel like any other process (#7514), so a value that cannot survive
 * `JSON.parse(JSON.stringify(x))` byte-equal must not be able to enter. That rules out a closure,
 * an Effect value, a DOM node and — the one that nearly slipped in — a `Duration.Duration`, which
 * is why the armed prefix window is stored as `timeoutMs` rather than the router's own `Armed`.
 *
 * Workspaces are a keyed map beside an active id, re-derived from the founder's Studio
 * (`monorepo/packages/studio/studio.ts`). Two things the port does not carry over: Studio reads
 * its ordering off `Object.keys(draft.workspaces)`, which makes "the nearest workspace" depend on
 * JS key order, so `order` states it; and Studio mints ids inside the mutator through `forge`'s
 * random `factory`, which a pure reducer cannot do, so `nextId` mints them deterministically and
 * a restored desk keeps minting where it left off.
 */

import {type LayoutTree, type WindowId, windows} from "../layout/index.ts";
import type {ViewState} from "../window/host.ts";

/** A workspace id. The shell mints it; nothing outside this module generates one. */
export type WorkspaceId = string;

/**
 * One named desk: a layout tree and the window focus sits in. `focused` always names a window the
 * tree holds — every cell that removes a window moves it first.
 */
export interface Workspace {
	readonly id: WorkspaceId;
	readonly layout: LayoutTree;
	readonly focused: WindowId;
}

/**
 * The prefix, as state can hold it. `pending` is the sequence typed since the prefix armed and
 * `timeoutMs` how long this window lasts — the router's `Armed` carries a `Duration.Duration`,
 * which is an object with methods and so cannot be checkpointed.
 */
export type PrefixSnapshot =
	| {readonly armed: false}
	| {readonly armed: true; readonly pending: readonly string[]; readonly timeoutMs: number};

export const disarmed: PrefixSnapshot = {armed: false};

/**
 * The whole shell. `views` is keyed by window id across every workspace, not nested under one:
 * window ids are unique desk-wide, and two windows over one process own two view slots (the Vim
 * buffer model), which a per-window key states directly.
 */
export interface ShellState {
	readonly workspaces: Readonly<Record<WorkspaceId, Workspace>>;
	/** The workspaces in the order they were created — what "the nearest workspace" is measured in. */
	readonly order: readonly WorkspaceId[];
	readonly activeWorkspace: WorkspaceId;
	readonly views: Readonly<Record<WindowId, ViewState>>;
	readonly prefix: PrefixSnapshot;
	/** The next mint. Every id the shell hands out is `<kind>-<n>` for one `n`, spent once. */
	readonly nextId: number;
}

/** The ids one mint spends. Distinct prefixes over one counter, so no two ids can collide. */
export interface MintedIds {
	readonly workspace: WorkspaceId;
	readonly window: WindowId;
	readonly stack: string;
}

export const mint = (nextId: number): MintedIds => ({
	workspace: `workspace-${nextId}`,
	window: `window-${nextId}`,
	stack: `stack-${nextId}`,
});

/**
 * The workspace `activeWorkspace` names. Every cell holds the invariant that one exists, and none
 * of them throws when it does not: a reducer runs inside the kernel's commit loop over state a
 * checkpoint handed back, so a corrupt desk must leave the shell inert, not raise.
 */
export const activeWorkspace = (state: ShellState): Workspace | undefined =>
	state.workspaces[state.activeWorkspace];

/** Every window of a workspace, in reading order — the order `window.close` moves focus along. */
export const windowIds = (workspace: Workspace): readonly WindowId[] =>
	[...windows(workspace.layout.root)].map((window) => window.id);

/** The process bound to a window, or `null` for an empty window or a window the tree does not hold. */
export const processOf = (workspace: Workspace, windowId: WindowId): string | null => {
	for (const window of windows(workspace.layout.root)) {
		if (window.id === windowId) return window.processId;
	}
	return null;
};

export const hasWindow = (workspace: Workspace, windowId: WindowId): boolean =>
	windowIds(workspace).includes(windowId);

/** Replace the active workspace, leaving every other field alone. */
export const withActive = (state: ShellState, workspace: Workspace): ShellState => ({
	...state,
	workspaces: {...state.workspaces, [state.activeWorkspace]: workspace},
});

/**
 * The `views` map without the named windows. Rebuilt by iteration rather than `delete`, so the
 * key order a checkpoint serializes is the insertion order of what remains.
 */
export const withoutViews = (
	views: ShellState["views"],
	dropped: readonly WindowId[],
): ShellState["views"] => {
	const kept: Record<WindowId, ViewState> = {};
	for (const [windowId, view] of Object.entries(views)) {
		if (!dropped.includes(windowId)) kept[windowId] = view;
	}
	return kept;
};
