/**
 * The pure layout tree: split, remove, directional focus, resize and zoom, every one of them a
 * total function on immutable data addressed by id. Hand-ported from Studio's
 * `monorepo/packages/layout-tree/src/index.ts` after the invariant audit #7551 asked for; nothing
 * here imports React, Demlik or Effect, and no index path reaches a signature.
 *
 * Two things the port deliberately does not carry over. Studio's `find` returns out of the first
 * nested stack it descends into and never reads the siblings after it; `find` here walks all of
 * them. Studio's `orentationFromDirection` maps left/right to `"vertical"` because its renderer
 * inverts orientation; here left/right is `"horizontal"`, the meaning the node types pin.
 */

import {
	createStack,
	createWindow,
	type Direction,
	type Edge,
	type LayoutNode,
	type LayoutTree,
	type NodeId,
	type Orientation,
	resolveSizes,
	type StackId,
	type StackNode,
	type WindowId,
	type WindowNode,
} from "./node.ts";

/** The ids the shell mints for one split. `stack` is spent only when the split nests a new stack. */
export interface SplitIds {
	readonly window: WindowId;
	readonly stack: StackId;
}

/** Every window under `node`, left to right, top to bottom. */
export function* windows(node: LayoutNode): Generator<WindowNode> {
	if (node.tag === "window") {
		yield node;
		return;
	}
	for (const child of node.children) {
		yield* windows(child);
	}
}

/** The first window the predicate accepts, reading every sibling — Studio's `find` skipped some. */
export function find(
	tree: LayoutTree,
	predicate: (window: WindowNode) => boolean,
): WindowNode | null {
	for (const window of windows(tree.root)) {
		if (predicate(window)) return window;
	}
	return null;
}

export function findWindow(tree: LayoutTree, windowId: WindowId): WindowNode | null {
	return find(tree, (window) => window.id === windowId);
}

export function findStack(tree: LayoutTree, stackId: StackId): StackNode | null {
	return findStackIn(tree.root, stackId);
}

function findStackIn(stack: StackNode, stackId: StackId): StackNode | null {
	if (stack.id === stackId) return stack;
	for (const child of stack.children) {
		if (child.tag !== "stack") continue;
		const found = findStackIn(child, stackId);
		if (found) return found;
	}
	return null;
}

/** The window at one end of a stack's subtree, in reading order. */
export function findChildWindow(tree: LayoutTree, stackId: StackId, edge: Edge): WindowNode | null {
	const stack = findStack(tree, stackId);
	return stack ? edgeWindow(stack, edge) : null;
}

function edgeWindow(node: LayoutNode, edge: Edge): WindowNode | null {
	if (node.tag === "window") return node;
	const child = edge === "start" ? node.children[0] : node.children[node.children.length - 1];
	return child ? edgeWindow(child, edge) : null;
}

const axisOf = (direction: Direction): Orientation =>
	direction === "left" || direction === "right" ? "horizontal" : "vertical";

const isBackward = (direction: Direction): boolean => direction === "left" || direction === "up";

/**
 * The window focus lands on when it moves `direction` out of `windowId`: climb to the nearest
 * ancestor laid out along that axis that has a neighbour on that side, then enter the neighbour's
 * subtree at the edge nearest the window we left. `null` when the edge of the tree is reached.
 */
export function findSibling(
	tree: LayoutTree,
	windowId: WindowId,
	direction: Direction,
): WindowNode | null {
	const ancestors = ancestorsOf(tree.root, windowId);
	if (!ancestors) return null;

	const axis = axisOf(direction);
	const step = isBackward(direction) ? -1 : 1;
	const entryEdge: Edge = isBackward(direction) ? "end" : "start";

	let childId: NodeId = windowId;
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const stack = ancestors[i];
		if (!stack) return null;
		const index = stack.children.findIndex((child) => child.id === childId);
		if (index < 0) return null;
		if (stack.orientation === axis) {
			const neighbour = stack.children[index + step];
			if (neighbour) return edgeWindow(neighbour, entryEdge);
		}
		childId = stack.id;
	}
	return null;
}

/** The stacks from the root down to the window's parent, or `null` when no such window exists. */
function ancestorsOf(stack: StackNode, windowId: WindowId): StackNode[] | null {
	for (const child of stack.children) {
		if (child.tag === "window") {
			if (child.id === windowId) return [stack];
			continue;
		}
		const deeper = ancestorsOf(child, windowId);
		if (deeper) return [stack, ...deeper];
	}
	return null;
}

/**
 * Split `windowId` along `orientation`, seeding the new window with half the split window's share.
 * A stack holding one child flips to the new orientation instead of nesting; otherwise a differing
 * orientation nests a stack under `ids.stack`. Unknown windows and windows whose new ids are
 * already taken leave the tree untouched — `checkTree` is what proves a tree's ids unique.
 */
export function split(
	tree: LayoutTree,
	windowId: WindowId,
	orientation: Orientation,
	ids: SplitIds,
): LayoutTree {
	const taken = new Set<NodeId>(idsOf(tree.root));
	if (taken.has(ids.window) || taken.has(ids.stack)) return tree;
	const root = splitIn(tree.root, windowId, orientation, ids);
	return root ? {...tree, root} : tree;
}

function splitIn(
	stack: StackNode,
	windowId: WindowId,
	orientation: Orientation,
	ids: SplitIds,
): StackNode | null {
	const index = stack.children.findIndex(
		(child) => child.tag === "window" && child.id === windowId,
	);
	const target = index < 0 ? undefined : stack.children[index];
	if (target?.tag === "window") {
		const created = createWindow(ids.window);
		if (stack.orientation === orientation || stack.children.length === 1) {
			const children = [
				...stack.children.slice(0, index + 1),
				created,
				...stack.children.slice(index + 1),
			];
			const share = stack.sizes[windowId] ?? 100 / stack.children.length;
			const sizes = {...stack.sizes, [windowId]: share / 2, [ids.window]: share / 2};
			return {...stack, orientation, children, sizes: resolveSizes(children, sizes)};
		}
		return replaceChild(stack, windowId, createStack(ids.stack, orientation, [target, created]));
	}

	for (const child of stack.children) {
		if (child.tag !== "stack") continue;
		const next = splitIn(child, windowId, orientation, ids);
		if (next) return replaceChild(stack, child.id, next);
	}
	return null;
}

function idsOf(node: LayoutNode): NodeId[] {
	if (node.tag === "window") return [node.id];
	return [node.id, ...node.children.flatMap(idsOf)];
}

/**
 * Remove `windowId`, handing its share to the sibling it sat against. An emptied stack collapses into
 * its grandparent, a stack left holding one child is replaced by that child, and the root absorbs
 * a lone stack child. Removing the tree's last window is refused: the shell, not the tree, decides
 * what closing the last window means.
 */
export function remove(tree: LayoutTree, windowId: WindowId): LayoutTree {
	const result = removeIn(tree.root, windowId);
	if (!result.found || result.stack === null) return tree;

	let root = result.stack;
	let onlyChild = root.children.length === 1 ? root.children[0] : undefined;
	while (onlyChild?.tag === "stack") {
		root = {
			...root,
			orientation: onlyChild.orientation,
			children: onlyChild.children,
			sizes: onlyChild.sizes,
		};
		onlyChild = root.children.length === 1 ? root.children[0] : undefined;
	}

	return {root, zoomed: tree.zoomed === windowId ? null : tree.zoomed};
}

interface RemoveResult {
	readonly found: boolean;
	/** `null` when the stack lost its last child and its own parent must drop it. */
	readonly stack: StackNode | null;
}

function removeIn(stack: StackNode, windowId: WindowId): RemoveResult {
	const direct = stack.children.some((child) => child.tag === "window" && child.id === windowId);
	if (direct) {
		const next = withoutChild(stack, windowId);
		return {found: true, stack: next.children.length === 0 ? null : next};
	}

	for (const child of stack.children) {
		if (child.tag !== "stack") continue;
		const result = removeIn(child, windowId);
		if (!result.found) continue;
		if (result.stack === null) {
			const next = withoutChild(stack, child.id);
			return {found: true, stack: next.children.length === 0 ? null : next};
		}
		return {found: true, stack: replaceChild(stack, child.id, collapse(result.stack))};
	}
	return {found: false, stack};
}

/** A stack holding a single child is that child; its share moves with it at the parent. */
function collapse(stack: StackNode): LayoutNode {
	const only = stack.children.length === 1 ? stack.children[0] : undefined;
	return only ?? stack;
}

/**
 * The freed share goes to the neighbour the removed child sat against — the pane beside it grows,
 * as it does in tmux — which is also what makes `remove` the exact inverse of the `split` that
 * created the child. Spreading it over every sibling instead would not round-trip.
 */
function withoutChild(stack: StackNode, childId: NodeId): StackNode {
	const index = stack.children.findIndex((child) => child.id === childId);
	const children = stack.children.filter((child) => child.id !== childId);
	const heir = children[index - 1] ?? children[0];
	const sizes: Record<NodeId, number> = {};
	for (const child of children) {
		const freed = child.id === heir?.id ? (stack.sizes[childId] ?? 0) : 0;
		sizes[child.id] = (stack.sizes[child.id] ?? 0) + freed;
	}
	return {...stack, children, sizes: resolveSizes(children, sizes)};
}

function replaceChild(stack: StackNode, childId: NodeId, node: LayoutNode): StackNode {
	const children = stack.children.map((child) => (child.id === childId ? node : child));
	const sizes: Record<NodeId, number> = {...stack.sizes};
	if (node.id !== childId) {
		sizes[node.id] = sizes[childId] ?? 0;
		delete sizes[childId];
	}
	return {...stack, children, sizes: resolveSizes(children, sizes)};
}

/**
 * Record a resize of one stack. `sizes` is percent of that stack's extent — the shape
 * react-resizable-panels reports — and is normalised back to a total map summing to 100.
 */
export function resize(
	tree: LayoutTree,
	stackId: StackId,
	sizes: Readonly<Record<NodeId, number>>,
): LayoutTree {
	const root = mapStack(tree.root, stackId, (stack) => ({
		...stack,
		sizes: resolveSizes(stack.children, sizes),
	}));
	return root ? {...tree, root} : tree;
}

/** Attach or detach a window's process. A window carries no other payload. */
export function setProcess(
	tree: LayoutTree,
	windowId: WindowId,
	processId: string | null,
): LayoutTree {
	const root = mapWindow(tree.root, windowId, (window) => ({...window, processId}));
	return root ? {...tree, root} : tree;
}

/** Render `windowId` alone. Zoom never writes `sizes`, so unzoom restores the layout exactly. */
export function zoom(tree: LayoutTree, windowId: WindowId): LayoutTree {
	return findWindow(tree, windowId) ? {...tree, zoomed: windowId} : tree;
}

export function unzoom(tree: LayoutTree): LayoutTree {
	return tree.zoomed === null ? tree : {...tree, zoomed: null};
}

/**
 * One tree as one string, so a consumer that compares by identity can still ask "is this the same
 * layout?". Every snapshot the page receives is decoded afresh, so two snapshots carrying an
 * identical tree hold two objects `Object.is` calls different (#7782, #7839); two identical trees
 * produce one string here, and any change to structure, order, orientation, sizes, a window's
 * process or the zoomed window produces another.
 *
 * Ids are arbitrary strings, so the shape is built as nested arrays and serialized rather than
 * joined with a delimiter a window could be named after.
 */
export function layoutSignature(tree: LayoutTree): string {
	return JSON.stringify([tree.zoomed, nodeShape(tree.root)]);
}

function nodeShape(node: LayoutNode): unknown {
	if (node.tag === "window") return ["w", node.id, node.processId];
	return [
		"s",
		node.id,
		node.orientation,
		node.children.map((child) => [nodeShape(child), node.sizes[child.id] ?? null]),
	];
}

function mapStack(
	stack: StackNode,
	stackId: StackId,
	f: (stack: StackNode) => StackNode,
): StackNode | null {
	if (stack.id === stackId) return f(stack);
	for (const child of stack.children) {
		if (child.tag !== "stack") continue;
		const next = mapStack(child, stackId, f);
		if (next) return replaceChild(stack, child.id, next);
	}
	return null;
}

function mapWindow(
	stack: StackNode,
	windowId: WindowId,
	f: (window: WindowNode) => WindowNode,
): StackNode | null {
	for (const child of stack.children) {
		if (child.tag === "window") {
			if (child.id !== windowId) continue;
			return replaceChild(stack, windowId, f(child));
		}
		const next = mapWindow(child, windowId, f);
		if (next) return replaceChild(stack, child.id, next);
	}
	return null;
}
