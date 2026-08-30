import type {LineageEdge, LineageNode, LineageProjection} from "../shared/lineage.js";

export const SESSION_WORKING_SET_PAGE_SIZE = 3;
export const SESSION_WORKING_SET_MAX_NODES = 9;
export const SESSION_WORKING_SET_ARCHIVE_THRESHOLD = 48;
const PINNED_CONTEXT_LIMIT = 6;

export type SessionWorkingSetFilter = "all" | "lineage" | "roots";

export interface SessionWorkingSetOptions {
	readonly query?: string;
	readonly filter?: SessionWorkingSetFilter;
	readonly page?: number;
	readonly pinnedIds?: ReadonlyArray<LineageNode["id"]>;
}

export interface SessionWorkingSet {
	readonly projection: LineageProjection;
	readonly totalCount: number;
	readonly matchedCount: number;
	readonly visibleCount: number;
	readonly hiddenCount: number;
	readonly page: number;
	readonly pageCount: number;
	readonly pageStart: number;
	readonly pageEnd: number;
	readonly hasNewer: boolean;
	readonly hasOlder: boolean;
}

const compareRecent = (left: LineageNode, right: LineageNode): number =>
	right.updatedAt - left.updatedAt ||
	right.createdAt - left.createdAt ||
	left.id.localeCompare(right.id);

const normalized = (value: string): string => value.toLocaleLowerCase("tr-TR").trim();

const matchesQuery = (node: LineageNode, query: string): boolean => {
	if (query.length === 0) return true;
	return [node.piSessionId, node.cwd, node.id].some((value) => normalized(value).includes(query));
};

const relationshipIndex = (edges: ReadonlyArray<LineageEdge>) => {
	const parents = new Map<LineageNode["id"], Array<LineageNode["id"]>>();
	const children = new Map<LineageNode["id"], Array<LineageNode["id"]>>();
	for (const edge of edges) {
		parents.set(edge.child, [...(parents.get(edge.child) ?? []), edge.parent]);
		children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge.child]);
	}
	return {parents, children};
};

const matchesFilter = (
	node: LineageNode,
	filter: SessionWorkingSetFilter,
	parents: ReadonlyMap<LineageNode["id"], ReadonlyArray<LineageNode["id"]>>,
	children: ReadonlyMap<LineageNode["id"], ReadonlyArray<LineageNode["id"]>>,
): boolean => {
	if (filter === "roots") return (parents.get(node.id)?.length ?? 0) === 0;
	if (filter === "lineage") {
		return (parents.get(node.id)?.length ?? 0) > 0 || (children.get(node.id)?.length ?? 0) > 0;
	}
	return true;
};

export const selectSessionWorkingSet = (
	projection: LineageProjection,
	options: SessionWorkingSetOptions = {},
): SessionWorkingSet => {
	const nodesById = new Map(projection.graph.nodes.map((node) => [node.id, node]));
	const {parents, children} = relationshipIndex(projection.graph.edges);
	const query = normalized(options.query ?? "");
	const filter = options.filter ?? "all";
	const matched = [...nodesById.values()]
		.filter((node) => matchesQuery(node, query) && matchesFilter(node, filter, parents, children))
		.sort(compareRecent);
	const archiveIsBounded = nodesById.size > SESSION_WORKING_SET_ARCHIVE_THRESHOLD;
	const pageSize = archiveIsBounded ? SESSION_WORKING_SET_PAGE_SIZE : Math.max(1, matched.length);
	const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
	const page = Math.min(Math.max(0, options.page ?? 0), pageCount - 1);
	const pageStart = page * pageSize;
	const pageNodes = matched.slice(pageStart, pageStart + pageSize);
	const mountLimit = archiveIsBounded ? SESSION_WORKING_SET_MAX_NODES : Number.POSITIVE_INFINITY;
	const visible = new Set<LineageNode["id"]>();
	const add = (id: LineageNode["id"]): void => {
		if (visible.size < mountLimit && nodesById.has(id)) visible.add(id);
	};

	const pinned = [...new Set(options.pinnedIds ?? [])].filter((id) => nodesById.has(id));
	for (const id of pinned) add(id);
	for (const node of pageNodes) add(node.id);
	const contextQueue = [...pinned];
	let contextCount = 0;
	while (
		contextQueue.length > 0 &&
		contextCount < PINNED_CONTEXT_LIMIT &&
		visible.size < mountLimit
	) {
		const id = contextQueue.shift();
		if (id === undefined) break;
		for (const relation of [...(parents.get(id) ?? []), ...(children.get(id) ?? [])]) {
			if (visible.has(relation)) continue;
			add(relation);
			contextQueue.push(relation);
			contextCount += 1;
			if (contextCount >= PINNED_CONTEXT_LIMIT || visible.size >= mountLimit) {
				break;
			}
		}
	}
	for (const node of pageNodes) {
		for (const relation of [...(parents.get(node.id) ?? []), ...(children.get(node.id) ?? [])]) {
			add(relation);
		}
	}

	const selectedNodes = [...visible]
		.map((id) => nodesById.get(id))
		.filter((node): node is LineageNode => node !== undefined);
	const selectedEdges = projection.graph.edges.filter(
		(edge) => visible.has(edge.parent) && visible.has(edge.child),
	);
	const selectedContinuity = projection.graph.continuity.filter(
		(observation) =>
			visible.has(observation.session) &&
			(observation.parent === undefined || visible.has(observation.parent)),
	);
	const selectedOwnership = projection.graph.ownership.filter((ownership) =>
		visible.has(ownership.session),
	);
	return {
		projection: {
			...projection,
			graph: {
				version: 2,
				nodes: selectedNodes,
				edges: selectedEdges,
				continuity: selectedContinuity,
				ownership: selectedOwnership,
			},
		},
		totalCount: nodesById.size,
		matchedCount: matched.length,
		visibleCount: selectedNodes.length,
		hiddenCount: Math.max(0, nodesById.size - selectedNodes.length),
		page,
		pageCount,
		pageStart: matched.length === 0 ? 0 : pageStart + 1,
		pageEnd: Math.min(matched.length, pageStart + pageSize),
		hasNewer: page > 0,
		hasOlder: page + 1 < pageCount,
	};
};
