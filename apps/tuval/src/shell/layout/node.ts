/**
 * The layout tree's nodes and the size arithmetic every operation shares.
 *
 * `"horizontal"` means the children sit side by side in a row; `"vertical"` means they stack top
 * to bottom. Studio inverts this at its render boundary — this port does not, and no orientation
 * flip appears anywhere here (#7551).
 *
 * Ids are plain strings: `Schema.brand` would pull Effect into a module the ticket keeps free of
 * it, and `.glossary/LANGUAGE.md` rejects the hand-rolled phantom-symbol brand as the substitute.
 */

/** A window id. The shell mints it; this module never generates one. */
export type WindowId = string;

/** A stack id. */
export type StackId = string;

export type NodeId = WindowId | StackId;

/** `"horizontal"`: children side by side. `"vertical"`: children top to bottom. */
export type Orientation = "horizontal" | "vertical";

export type Direction = "left" | "right" | "up" | "down";

/** Which end of a stack's children a descent enters from, in reading order. */
export type Edge = "start" | "end";

/**
 * A view onto at most one process. `processId` holds the kernel's `ProcessId`
 * ([`src/process/process.ts`](../../process/process.ts)), which is a branded string and so
 * assignable here; the type is not imported, because that module imports Effect.
 * `null` is a first-class value: an empty window is an ordinary node.
 */
export interface WindowNode {
	readonly tag: "window";
	readonly id: WindowId;
	readonly processId: string | null;
}

/**
 * A row or column of children. `sizes` is percent of the stack's own extent, never pixels — every
 * tab mirrors one desk at a different width. Min/max are render-time props and live nowhere here.
 * Every operation in this module leaves `sizes` keyed by exactly `children` and summing to 100.
 */
export interface StackNode {
	readonly tag: "stack";
	readonly id: StackId;
	readonly orientation: Orientation;
	readonly children: readonly LayoutNode[];
	readonly sizes: Readonly<Record<NodeId, number>>;
}

export type LayoutNode = WindowNode | StackNode;

/** `zoomed` names the one window rendered alone. Zooming never writes `sizes`, so unzoom restores. */
export interface LayoutTree {
	readonly root: StackNode;
	readonly zoomed: WindowId | null;
}

export function createWindow(id: WindowId, processId: string | null = null): WindowNode {
	return {tag: "window", id, processId};
}

/**
 * `sizes` may be partial or absent: a child the map does not name takes an even share of what the
 * named ones leave, and the result is scaled to 100.
 */
export function createStack(
	id: StackId,
	orientation: Orientation,
	children: readonly LayoutNode[],
	sizes: Readonly<Record<NodeId, number>> = {},
): StackNode {
	return {tag: "stack", id, orientation, children, sizes: resolveSizes(children, sizes)};
}

export function createTree(root: StackNode, zoomed: WindowId | null = null): LayoutTree {
	return {root, zoomed};
}

/** Percent values may not sum exactly after division; the renderer rounds to 3 decimals. */
export const SIZE_TOLERANCE = 0.01;

/**
 * The total size map for `children`: named non-negative values are kept, unnamed children split
 * whatever is left evenly, keys naming no child are dropped, and the whole map is scaled to 100.
 * An all-zero or empty input falls back to an even split.
 */
export function resolveSizes(
	children: readonly LayoutNode[],
	sizes: Readonly<Record<NodeId, number>>,
): Readonly<Record<NodeId, number>> {
	if (children.length === 0) return {};

	const named: number[] = [];
	let namedTotal = 0;
	let unnamed = 0;
	for (const child of children) {
		const value = sizes[child.id];
		if (value === undefined || !Number.isFinite(value) || value < 0) {
			named.push(Number.NaN);
			unnamed += 1;
		} else {
			named.push(value);
			namedTotal += value;
		}
	}

	const share = unnamed === 0 ? 0 : Math.max(0, 100 - namedTotal) / unnamed;
	const raw = named.map((value) => (Number.isNaN(value) ? share : value));
	const total = raw.reduce((sum, value) => sum + value, 0);
	const even = 100 / children.length;

	const resolved: Record<NodeId, number> = {};
	children.forEach((child, index) => {
		resolved[child.id] = total > 0 ? ((raw[index] ?? 0) * 100) / total : even;
	});
	return resolved;
}
