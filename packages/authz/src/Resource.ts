/**
 * `Resource` — a generic recursive tree node, the scope a `Relation`-backed
 * capability is proved *over* (ADR 0107: ReBAC authority is resource-scoped). A
 * node is a `(type, id)` with an optional `parent`, so authority on an ancestor
 * covers its descendants: a `moderates` tuple on `platform` covers a report
 * filed under it (the recursion is also ADR 0107's nested-platform reach —
 * designed-for, not built). Vocab-free: `type`/`id` are caller-supplied strings.
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

/**
 * The canonical storage key for a resource node — its `(type, id)` pair as
 * `type:id`. The ONE encoding both sides of the ReBAC seam agree on: the offline
 * tuple mint (`@kampus/founder-seed`) writes `relation_tuple.object` as this, and
 * `RelationStoreLive` reads it back as this, so a discharge over the node finds
 * the seeded tuple. Centralized here (not duplicated per writer/reader) so the
 * write key and the read key cannot diverge.
 */
export const key = (node: Resource): string => `${node.type}:${node.id}`;

/**
 * The platform root — the top of the resource tree, the scope platform-wide
 * authority (`moderates`, `admin`) is held over. A fixed singleton node so
 * `key(platform)` is one stable string across the offline mint and the runtime
 * read. Vocab-free: a generic structural root, named no kamp.us product noun.
 */
export const platform: Resource = resource("platform", "platform");

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
