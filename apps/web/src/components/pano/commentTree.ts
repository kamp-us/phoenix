/**
 * Pure (no hooks/refs) so the tree is derived in the same render the nodes appear
 * in — an effect round-trip would drop a freshly-arrived live node for a frame.
 */

export interface CommentNode<Ref> {
	id: string;
	parentId: string | null;
	deletedAt: string | null;
	body: string;
	ref: Ref;
}

export interface PlacedComment<Ref> {
	id: string;
	ref: Ref;
}

export interface CommentTree<Ref> {
	roots: Array<PlacedComment<Ref>>;
	childrenByParent: Map<string, Array<PlacedComment<Ref>>>;
	bodyById: Map<string, string>;
	refById: Map<string, Ref>;
	visibleCount: number;
}

/**
 * A comment renders iff it isn't soft-deleted OR has a visible descendant — a
 * soft-deleted parent stays as a `[silindi]` tombstone so its live reply has
 * somewhere to hang. A child whose parent isn't visible is promoted to a root so
 * it never disappears.
 */
export function buildCommentTree<Ref>(nodes: ReadonlyArray<CommentNode<Ref>>): CommentTree<Ref> {
	const bodyById = new Map<string, string>();
	const refById = new Map<string, Ref>();
	for (const node of nodes) {
		bodyById.set(node.id, node.body);
		refById.set(node.id, node.ref);
	}

	const visible = new Set<string>();
	for (const node of nodes) if (!node.deletedAt) visible.add(node.id);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes) {
			if (visible.has(node.id)) continue;
			if (!node.deletedAt) continue;
			if (nodes.some((other) => other.parentId === node.id && visible.has(other.id))) {
				visible.add(node.id);
				changed = true;
			}
		}
	}

	const childrenByParent = new Map<string, Array<PlacedComment<Ref>>>();
	const roots: Array<PlacedComment<Ref>> = [];
	for (const node of nodes) {
		if (!visible.has(node.id)) continue;
		if (node.parentId && visible.has(node.parentId)) {
			const list = childrenByParent.get(node.parentId) ?? [];
			list.push({id: node.id, ref: node.ref});
			childrenByParent.set(node.parentId, list);
		} else {
			roots.push({id: node.id, ref: node.ref});
		}
	}

	let visibleCount = roots.length;
	for (const list of childrenByParent.values()) visibleCount += list.length;

	return {roots, childrenByParent, bodyById, refById, visibleCount};
}
