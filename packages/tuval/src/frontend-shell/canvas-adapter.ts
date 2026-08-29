import {type Edge, MarkerType, type Node} from "@xyflow/react";
import type {
	ContinuityObservation,
	LineageEdge,
	LineageNode,
	LineageProjection,
} from "../shared/lineage.js";
import {
	DEFAULT_NODE_DETAIL_LEVEL,
	type NodeAttachment,
	type NodeDetailLevel,
} from "./node-detail.js";

export interface SessionNodeData extends Record<string, unknown> {
	readonly session: LineageNode;
	readonly title: string;
	readonly incomingKinds: ReadonlyArray<LineageEdge["kind"]>;
	readonly continuity: ReadonlyArray<ContinuityObservation>;
	readonly detailLevel: NodeDetailLevel;
	readonly attachment: NodeAttachment | null;
}

export interface SessionNodeProjectionOptions {
	readonly detailLevel?: NodeDetailLevel;
	readonly attachments?: ReadonlyMap<string, NodeAttachment>;
}

export interface LineageEdgeData extends Record<string, unknown> {
	readonly kind: LineageEdge["kind"];
	readonly label: "Oluşturma" | "Dallanma";
	readonly detail: string;
	readonly laneOffset: number;
	readonly routeY: number | null;
}

export type SessionCanvasNode = Node<SessionNodeData, "session">;
export type SessionRelationshipEdge = Edge<LineageEdgeData, "relationship">;

export const sessionTitle = (path: string): string => {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
};

const compareText = (left: string, right: string): number =>
	left === right ? 0 : left < right ? -1 : 1;

const nodeDepths = (projection: LineageProjection): ReadonlyMap<string, number> => {
	const parents = new Map<string, Array<string>>();
	for (const edge of projection.graph.edges) {
		const current = parents.get(edge.child) ?? [];
		current.push(edge.parent);
		parents.set(edge.child, current);
	}
	const cache = new Map<string, number>();
	const depthOf = (id: string, visiting = new Set<string>()): number => {
		const cached = cache.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return 0;
		const nextVisiting = new Set(visiting).add(id);
		const depth = Math.max(
			0,
			...(parents.get(id) ?? []).map((parent) => depthOf(parent, nextVisiting) + 1),
		);
		cache.set(id, depth);
		return depth;
	};
	for (const node of projection.graph.nodes) depthOf(node.id);
	return cache;
};

const positions = (projection: LineageProjection): ReadonlyMap<string, {x: number; y: number}> => {
	const depths = nodeDepths(projection);
	const layers = new Map<number, Array<LineageNode>>();
	for (const node of projection.graph.nodes) {
		const depth = depths.get(node.id) ?? 0;
		const layer = layers.get(depth) ?? [];
		layer.push(node);
		layers.set(depth, layer);
	}
	const result = new Map<string, {x: number; y: number}>();
	for (const [depth, layer] of layers) {
		layer.sort((left, right) => compareText(left.id, right.id));
		const center = (layer.length - 1) / 2;
		layer.forEach((node, index) => {
			result.set(node.id, {
				x: depth * 560,
				y: Math.round((index - center) * 240),
			});
		});
	}
	return result;
};

const nodeFrom = (
	projection: LineageProjection,
	node: LineageNode,
	position: {readonly x: number; readonly y: number},
	options: SessionNodeProjectionOptions,
): SessionCanvasNode => {
	const continuity = projection.graph.continuity.filter((entry) => entry.session === node.id);
	const incomingKinds = [
		...new Set(
			projection.graph.edges.filter((edge) => edge.child === node.id).map((edge) => edge.kind),
		),
	].sort(compareText);
	const continuityLabel = continuity.length === 0 ? "" : `, ${continuity.length} devam kaydı`;
	const attachment = options.attachments?.get(node.id) ?? null;
	return {
		id: node.id,
		type: "session",
		position,
		ariaLabel: `${sessionTitle(node.cwd)} oturumu, ${node.piSessionId}${continuityLabel}`,
		data: {
			session: node,
			title: sessionTitle(node.cwd),
			incomingKinds,
			continuity,
			detailLevel: options.detailLevel ?? DEFAULT_NODE_DETAIL_LEVEL,
			attachment,
		},
	};
};

export const toSessionNodes = (
	projection: LineageProjection,
	options: SessionNodeProjectionOptions = {},
): ReadonlyArray<SessionCanvasNode> => {
	const projectedPositions = positions(projection);
	return [...projection.graph.nodes]
		.sort((left, right) => compareText(left.id, right.id))
		.map((node) =>
			nodeFrom(projection, node, projectedPositions.get(node.id) ?? {x: 0, y: 0}, options),
		);
};

export const reconcileSessionNodes = (
	current: ReadonlyArray<SessionCanvasNode>,
	projection: LineageProjection,
	options: SessionNodeProjectionOptions = {},
): ReadonlyArray<SessionCanvasNode> => {
	const previous = new Map(current.map((node) => [node.id, node]));
	return toSessionNodes(projection, options).map((next) => {
		const node = previous.get(next.id);
		return node === undefined
			? next
			: {
					...node,
					ariaLabel: next.ariaLabel ?? node.ariaLabel ?? next.data.title,
					data: next.data,
				};
	});
};

const edgeLabel = (
	edge: LineageEdge,
	laneOffset: number,
	routeY: number | null,
): LineageEdgeData =>
	edge.kind === "spawn"
		? {kind: "spawn", label: "Oluşturma", detail: `run ${edge.runId}`, laneOffset, routeY}
		: {
				kind: "fork",
				label: "Dallanma",
				detail: `kaynak ${edge.source}`,
				laneOffset,
				routeY,
			};

const edgeAriaLabel = (edge: LineageEdge, nodes: ReadonlyMap<string, LineageNode>): string => {
	const parent = nodes.get(edge.parent)?.piSessionId ?? edge.parent;
	const child = nodes.get(edge.child)?.piSessionId ?? edge.child;
	const relation = edge.kind === "spawn" ? "oluşturma" : "dallanma";
	return `${parent} oturumundan ${child} oturumuna ${relation} ilişkisi, ${edgeLabel(edge, 0, null).detail}`;
};

export const toLineageEdges = (
	projection: LineageProjection,
): ReadonlyArray<SessionRelationshipEdge> => {
	const nodes = new Map(projection.graph.nodes.map((node) => [node.id, node]));
	const sorted = [...projection.graph.edges].sort((left, right) => compareText(left.id, right.id));
	const depths = nodeDepths(projection);
	const projectedPositions = positions(projection);
	const yPositions = [...projectedPositions.values()].map((position) => position.y);
	const minY = Math.min(0, ...yPositions);
	const maxY = Math.max(0, ...yPositions) + 216;
	const routedEdges = sorted.filter((edge) => {
		const depthDistance = (depths.get(edge.child) ?? 0) - (depths.get(edge.parent) ?? 0);
		const sourceY = projectedPositions.get(edge.parent)?.y ?? 0;
		const targetY = projectedPositions.get(edge.child)?.y ?? 0;
		return depthDistance > 1 || Math.abs(targetY - sourceY) > 240;
	});
	const routeY = new Map(
		routedEdges.map((edge, index) => [
			edge.id,
			index % 2 === 0
				? minY - 32 - Math.floor(index / 2) * 24
				: maxY + 32 + Math.floor(index / 2) * 24,
		]),
	);
	const coincident = new Map<string, ReadonlyArray<LineageEdge>>();
	for (const edge of sorted) {
		const key = `${edge.parent}\u0000${edge.child}`;
		coincident.set(key, [...(coincident.get(key) ?? []), edge]);
	}
	return sorted.map((edge) => {
		const siblings = coincident.get(`${edge.parent}\u0000${edge.child}`) ?? [edge];
		const index = siblings.findIndex((candidate) => candidate.id === edge.id);
		const laneOffset = siblings.length === 1 ? 0 : (index - (siblings.length - 1) / 2) * 32;
		return {
			id: edge.id,
			type: "relationship" as const,
			source: edge.parent,
			target: edge.child,
			sourceHandle: "relation-out",
			targetHandle: "relation-in",
			ariaLabel: edgeAriaLabel(edge, nodes),
			...(edge.kind === "spawn"
				? {
						markerEnd: {
							type: MarkerType.ArrowClosed,
							color: "currentColor",
							width: 24,
							height: 24,
							strokeWidth: 1.5,
						},
					}
				: {}),
			data: edgeLabel(edge, laneOffset, routeY.get(edge.id) ?? null),
		};
	});
};

export const reconcileLineageEdges = (
	current: ReadonlyArray<SessionRelationshipEdge>,
	projection: LineageProjection,
): ReadonlyArray<SessionRelationshipEdge> => {
	const previous = new Map(current.map((edge) => [edge.id, edge]));
	return toLineageEdges(projection).map((next) => {
		const edge = previous.get(next.id);
		return edge === undefined
			? next
			: {...edge, ...next, ...(next.data === undefined ? {} : {data: next.data})};
	});
};
