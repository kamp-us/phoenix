/**
 * The layout tree's nodes and the size arithmetic every operation shares.
 *
 * `"horizontal"` means the children sit side by side in a row; `"vertical"` means they stack top
 * to bottom. Studio inverts this at its render boundary — this port does not, and no orientation
 * flip appears anywhere here (#7551).
 *
 * Ids are plain strings: `Schema.brand` would put an Effect type on every id this module hands
 * out, and `.glossary/LANGUAGE.md` rejects the hand-rolled phantom-symbol brand as the substitute.
 * The one `effect` import here is `Predicate.isObject`, a pure guard the pin's own guidance says to
 * use instead of a hand-rolled `isRecord` (#7764); it touches no id and pulls in no runtime.
 */
import {Predicate} from "effect";

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
	/**
	 * The bound program declared `takesKeys` (`src/registry/program.ts`), so the shell may forward a
	 * key to this window's process. Written only beside `processId` and dropped with it, because it
	 * describes the binding rather than the window; absent on an unbound window and on every window
	 * bound before #7973, which is the safe reading — a key nobody declared for is not sent.
	 */
	readonly takesKeys?: true;
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

/**
 * A window node, bound or not. `setProcess` rebuilds through here rather than spreading the old
 * node, so the pair can never drift: unbinding drops the declaration with the process, and a
 * `takesKeys` handed in beside a `null` process is dropped too.
 */
export function createWindow(
	id: WindowId,
	processId: string | null = null,
	takesKeys = false,
): WindowNode {
	return processId !== null && takesKeys
		? {tag: "window", id, processId, takesKeys: true}
		: {tag: "window", id, processId};
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

export function isWindowNode(value: unknown): value is WindowNode {
	return (
		Predicate.isObject(value) &&
		value.tag === "window" &&
		typeof value.id === "string" &&
		(value.processId === null || typeof value.processId === "string") &&
		(value.takesKeys === undefined || (value.takesKeys === true && value.processId !== null))
	);
}

export function isStackNode(value: unknown): value is StackNode {
	return (
		Predicate.isObject(value) &&
		value.tag === "stack" &&
		typeof value.id === "string" &&
		(value.orientation === "horizontal" || value.orientation === "vertical") &&
		Array.isArray(value.children) &&
		value.children.every(isLayoutNode) &&
		Predicate.isObject(value.sizes) &&
		Object.values(value.sizes).every((size) => typeof size === "number")
	);
}

/**
 * Is this a node of the tree? Total over the union and recursive through `children`, because a
 * checkpointed layout re-enters as `unknown` and every reader here walks it without a guard of its
 * own. Hand-written predicates rather than a Schema decode: this module stays free of Effect
 * (#7551), and the interfaces above stay the shape's one declaration.
 */
export function isLayoutNode(value: unknown): value is LayoutNode {
	return isWindowNode(value) || isStackNode(value);
}

/** `sizes` is checked for number values and not for its sum — `resolveSizes` re-derives that. */
export function isLayoutTree(value: unknown): value is LayoutTree {
	return (
		Predicate.isObject(value) &&
		isStackNode(value.root) &&
		(value.zoomed === null || typeof value.zoomed === "string")
	);
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
