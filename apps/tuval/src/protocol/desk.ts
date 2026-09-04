/**
 * Desk state on the wire: workspaces keyed by id with one active, a layout tree of windows with
 * stable ids, a focused window per workspace, and an optional process bound to each window.
 *
 * All desk state lives in the kernel (#7617 R1.3) and reaches the page only through `Snapshot` and
 * `Patch`, so these are the types the shell core (#7554) adopts rather than redefining.
 */

import {Schema} from "effect";
import {ProcessId, WindowId, WorkspaceId} from "./ids.ts";

/** One window: a stable id, and the process it is bound to while something runs in it. */
export const Window = Schema.Struct({
	id: WindowId,
	process: Schema.optionalKey(ProcessId),
});
export type Window = typeof Window.Type;

export const LayoutLeaf = Schema.Struct({
	kind: Schema.Literal("leaf"),
	window: WindowId,
});
export type LayoutLeaf = typeof LayoutLeaf.Type;
export type LayoutLeafEncoded = typeof LayoutLeaf.Encoded;

export type Orientation = "row" | "column";

export interface LayoutSplit {
	readonly kind: "split";
	readonly orientation: Orientation;
	readonly children: ReadonlyArray<LayoutNode>;
}

export interface LayoutSplitEncoded {
	readonly kind: "split";
	readonly orientation: Orientation;
	readonly children: ReadonlyArray<LayoutNodeEncoded>;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;
export type LayoutNodeEncoded = LayoutLeafEncoded | LayoutSplitEncoded;

// The tree is recursive, so the schema is written as a suspended union and its two types are
// declared by hand; the annotation is what lets `LayoutSplit` reference it before it is built.
export const LayoutNode: Schema.Codec<LayoutNode, LayoutNodeEncoded> = Schema.suspend(() =>
	Schema.Union([LayoutLeaf, LayoutSplit]),
);

export const LayoutSplit: Schema.Codec<LayoutSplit, LayoutSplitEncoded> = Schema.Struct({
	kind: Schema.Literal("split"),
	orientation: Schema.Literals(["row", "column"]),
	children: Schema.Array(LayoutNode),
});

export const Workspace = Schema.Struct({
	id: WorkspaceId,
	name: Schema.String,
	layout: LayoutNode,
	/** Where keystrokes land in this workspace; `null` while it holds no window. */
	focused: Schema.NullOr(WindowId),
});
export type Workspace = typeof Workspace.Type;

export const Desk = Schema.Struct({
	workspaces: Schema.Record(WorkspaceId, Workspace),
	activeWorkspace: WorkspaceId,
});
export type Desk = typeof Desk.Type;
