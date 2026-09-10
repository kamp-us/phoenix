import type {LayoutNode} from "../../protocol/desk.ts";
import {WindowId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, Snapshot} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import type {ShellState} from "../core/index.ts";
import type {LayoutNode as ShellLayoutNode} from "../layout/index.ts";

/**
 * The shell's layout tree as the protocol spells it. The vocabulary differs by one word on each
 * side — the shell says `horizontal` for children sitting side by side, the wire says `row` — and
 * this is the only place the two meet (`.glossary/LANGUAGE.md`, "Tuval: stack, orientation…").
 */
const asLayout = (node: ShellLayoutNode): LayoutNode =>
	node.tag === "window"
		? {kind: "leaf", window: WindowId.make(node.id)}
		: {
				kind: "split",
				orientation: node.orientation === "horizontal" ? "row" : "column",
				children: node.children.map(asLayout),
			};

/**
 * The desk as a `Snapshot`. The kernel does not send one yet, so the page builds it off the state it
 * does hold: the completion engine reads the workspace names, the window ids and the process rows
 * out of it and nothing else, and every one of those is here.
 */
export const commandSnapshot = (state: ShellState, descriptions: RegistryDescription): Snapshot => {
	const windows: Record<string, {readonly id: WindowId; readonly recency: number}> = {};
	const workspaces: Record<string, unknown> = {};
	let recency = 0;
	for (const workspaceId of state.order) {
		const workspace = state.workspaces[workspaceId];
		if (workspace === undefined) continue;
		workspaces[workspaceId] = {
			id: workspaceId,
			// The shell's workspaces carry an id and no name; the id is what a founder types.
			name: workspaceId,
			layout: asLayout(workspace.layout.root),
			focused: WindowId.make(workspace.focused),
		};
		for (const window of collectWindows(workspace.layout.root)) {
			recency += 1;
			windows[window] = {id: WindowId.make(window), recency};
		}
	}
	return new Snapshot({
		type: "snapshot",
		version: PROTOCOL_VERSION,
		rev: 0,
		desk: {workspaces, activeWorkspace: state.activeWorkspace} as Snapshot["desk"],
		windows: windows as Snapshot["windows"],
		processes: [],
		registry: descriptions,
	});
};

const collectWindows = (node: ShellLayoutNode): ReadonlyArray<string> =>
	node.tag === "window" ? [node.id] : node.children.flatMap(collectWindows);
