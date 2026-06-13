/**
 * Pure comment-tree derivation for the post-detail thread. Pure (no hooks/refs)
 * so it runs synchronously in the render the nodes appear in — no effect
 * round-trip, so a freshly-arrived live node is never dropped for a frame.
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
	/** Top-level comments, in connection order. */
	roots: Array<PlacedComment<Ref>>;
	/** parentId → its visible children, in connection order. */
	childrenByParent: Map<string, Array<PlacedComment<Ref>>>;
	/** id → body, for the inline edit composer's initial value. */
	bodyById: Map<string, string>;
	/** id → view ref, for the inline edit composer's write-back. */
	refById: Map<string, Ref>;
	visibleCount: number;
}

/**
 * Build the thread tree from the flat, ordered comment nodes.
 *
 * Visibility: a comment renders iff it isn't soft-deleted, OR it has at least
 * one visible descendant (a soft-deleted parent of a live reply stays as a
 * `[silindi]` tombstone so the reply has somewhere to hang). Computed from
 * leaves upward to a fixed point. A child whose parent isn't visible (or isn't
 * in the page) is promoted to a root so it never disappears.
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
