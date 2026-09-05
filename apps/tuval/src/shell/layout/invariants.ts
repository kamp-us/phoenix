/**
 * What a well-formed layout tree is, as data. Every operation in `tree.ts` preserves these, the
 * property tests assert them, and the shell's persistence parse boundary can reject a restored
 * tree that breaks one instead of rendering it.
 */

import {
	type LayoutNode,
	type LayoutTree,
	type NodeId,
	SIZE_TOLERANCE,
	type StackId,
	type StackNode,
	type WindowId,
} from "./node.ts";

export type Violation =
	| {readonly kind: "duplicate-id"; readonly id: NodeId}
	/** A stack with no children: `remove` collapses one into its grandparent instead of leaving it. */
	| {readonly kind: "empty-stack"; readonly id: StackId}
	/** A non-root stack with one child: that child belongs in the grandparent, holding its share. */
	| {readonly kind: "redundant-stack"; readonly id: StackId}
	| {readonly kind: "sizes-key-unknown"; readonly stackId: StackId; readonly id: NodeId}
	| {readonly kind: "sizes-child-missing"; readonly stackId: StackId; readonly id: NodeId}
	| {readonly kind: "sizes-not-total"; readonly stackId: StackId; readonly sum: number}
	| {readonly kind: "zoomed-window-missing"; readonly id: WindowId};

export function checkTree(tree: LayoutTree): readonly Violation[] {
	const violations: Violation[] = [];
	const seen = new Set<NodeId>();

	const walk = (node: LayoutNode, isRoot: boolean): void => {
		if (seen.has(node.id)) violations.push({kind: "duplicate-id", id: node.id});
		seen.add(node.id);
		if (node.tag === "window") return;

		if (node.children.length === 0) violations.push({kind: "empty-stack", id: node.id});
		else if (node.children.length === 1 && !isRoot)
			violations.push({kind: "redundant-stack", id: node.id});

		violations.push(...checkSizes(node));
		for (const child of node.children) walk(child, false);
	};

	walk(tree.root, true);

	if (tree.zoomed !== null && !hasWindow(tree.root, tree.zoomed)) {
		violations.push({kind: "zoomed-window-missing", id: tree.zoomed});
	}
	return violations;
}

function checkSizes(stack: StackNode): readonly Violation[] {
	if (stack.children.length === 0) return [];
	const violations: Violation[] = [];
	const childIds = new Set<NodeId>(stack.children.map((child) => child.id));

	for (const id of Object.keys(stack.sizes)) {
		if (!childIds.has(id)) violations.push({kind: "sizes-key-unknown", stackId: stack.id, id});
	}
	for (const id of childIds) {
		if (stack.sizes[id] === undefined)
			violations.push({kind: "sizes-child-missing", stackId: stack.id, id});
	}

	const sum = Object.values(stack.sizes).reduce((total, value) => total + value, 0);
	if (Math.abs(sum - 100) > SIZE_TOLERANCE) {
		violations.push({kind: "sizes-not-total", stackId: stack.id, sum});
	}
	return violations;
}

function hasWindow(node: LayoutNode, windowId: WindowId): boolean {
	if (node.tag === "window") return node.id === windowId;
	return node.children.some((child) => hasWindow(child, windowId));
}
