/**
 * `Resource` — a generic recursive tree node, the scope a `Relation`-backed
 * capability is proved *over* (ADR 0107: ReBAC authority is resource-scoped).
 *
 * A node is a `(type, id)` pair with an optional `parent`, so authority granted
 * on an ancestor covers its descendants: a `moderates` tuple on `platform`
 * covers a report filed under it. This recursion is also the documented
 * **nested-platform / enterprise** reach (ADR 0107 "reachable on the recursive
 * `Resource` primitive") — designed-for, not built.
 *
 * Vocab-free: `type`/`id` are caller-supplied strings; the tree names no kamp.us
 * resource. {@link covers} is the ancestry relation the relation discharge
 * walks.
 */

/** A node in the resource tree — a `(type, id)` with an optional `parent`. */
export interface Resource {
	readonly type: string;
	readonly id: string;
	readonly parent?: Resource | undefined;
}

/** Build a {@link Resource}, optionally under a `parent`. */
export const resource = (type: string, id: string, parent?: Resource): Resource =>
	parent === undefined ? {type, id} : {type, id, parent};

/** Two nodes denote the same resource iff their `(type, id)` match. */
export const sameNode = (a: Resource, b: Resource): boolean => a.type === b.type && a.id === b.id;

/**
 * The ancestry chain of a node, **self first**, walking `parent` to the root.
 * The set of nodes any of which, held under a relation, authorizes an action on
 * the input node.
 */
export const ancestry = (node: Resource): ReadonlyArray<Resource> => {
	const chain: Array<Resource> = [];
	let current: Resource | undefined = node;
	while (current !== undefined) {
		chain.push(current);
		current = current.parent;
	}
	return chain;
};

/**
 * Does authority on `ancestor` cover `node`? True iff `ancestor` is `node`
 * itself or one of its ancestors — i.e. `ancestor` appears in `node`'s
 * {@link ancestry} chain.
 */
export const covers = (ancestor: Resource, node: Resource): boolean =>
	ancestry(node).some((step) => sameNode(step, ancestor));
