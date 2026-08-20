/**
 * `Resource` — the recursive tree a `Relation`-backed capability is proved over (ADR 0107:
 * ReBAC authority is resource-scoped). Authority on an ancestor covers its descendants: a
 * `moderates` tuple on `platform` covers a report filed under it. Vocab-free — `type`/`id`
 * are caller-supplied strings, never a kamp.us product noun.
 */

export interface Resource {
	readonly type: string;
	readonly id: string;
	readonly parent?: Resource | undefined;
}

export const resource = (type: string, id: string, parent?: Resource): Resource =>
	parent === undefined ? {type, id} : {type, id, parent};

/**
 * The ONE encoding both sides of the ReBAC seam agree on: the offline tuple mint
 * (`@kampus/founder-seed`) writes `relation_tuple.object` as this and `RelationStoreLive`
 * reads it back as this, so the write key and the read key cannot diverge.
 */
export const key = (node: Resource): string => `${node.type}:${node.id}`;

/** The root platform-wide authority (`moderates`, `admin`) is held over. */
export const platform: Resource = resource("platform", "platform");

export const sameNode = (a: Resource, b: Resource): boolean => a.type === b.type && a.id === b.id;

/** The chain from a node to the root, **self first** — holding any step authorizes the node. */
export const ancestry = (node: Resource): ReadonlyArray<Resource> => {
	const chain: Array<Resource> = [];
	let current: Resource | undefined = node;
	while (current !== undefined) {
		chain.push(current);
		current = current.parent;
	}
	return chain;
};

export const covers = (ancestor: Resource, node: Resource): boolean =>
	ancestry(node).some((step) => sameNode(step, ancestor));
