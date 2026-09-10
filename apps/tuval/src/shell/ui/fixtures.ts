/**
 * Desks the surface's tests render. Built through the layout tree's own constructors, so a fixture
 * cannot hold a `sizes` map the tree would never produce.
 */

import type {ShellState, Workspace} from "../core/index.ts";
import {disarmed} from "../core/index.ts";
import {initialDesk} from "../desk/state.ts";
import {createStack, createTree, createWindow, type LayoutTree} from "../layout/index.ts";
import {WindowId} from "../window/index.ts";

/** `window-1 | (window-2 / window-3)` — one column beside a stacked pair, the three-window desk. */
export const threeWindowTree = (): LayoutTree =>
	createTree(
		createStack(
			"stack-root",
			"horizontal",
			[
				createWindow("window-1", "process-1"),
				createStack("stack-right", "vertical", [
					createWindow("window-2"),
					createWindow("window-3", "process-3"),
				]),
			],
			{"window-1": 60, "stack-right": 40},
		),
	);

export const deskWith = (layout: LayoutTree, focused = "window-1"): ShellState => {
	const workspace: Workspace = {id: "workspace-0", layout, focused};
	return {
		workspaces: {[workspace.id]: workspace},
		order: [workspace.id],
		activeWorkspace: workspace.id,
		views: {},
		desk: initialDesk,
		prefix: disarmed,
		nextId: 4,
	};
};

export const threeWindowDesk = (focused = "window-1"): ShellState =>
	deskWith(threeWindowTree(), focused);

/** The tree's plain id at the window contract's brand — the one conversion, through the brand. */
export const asWindowId = (id: string): WindowId => WindowId.make(id);
