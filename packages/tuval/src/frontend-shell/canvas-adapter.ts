import type {Edge, Node} from "@xyflow/react";
import type {DiscoveredSession} from "../shared/discovery.js";

export interface SessionNodeData extends Record<string, unknown> {
	readonly session: DiscoveredSession;
	readonly title: string;
}

export type SessionCanvasNode = Node<SessionNodeData, "session">;
export type SessionRelationshipEdge = Edge<Record<string, never>, "relationship">;

export const sessionTitle = (path: string): string => {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
};

const positionFor = (index: number): {readonly x: number; readonly y: number} => {
	if (index === 0) return {x: 0, y: 0};
	const angle = (index * 137.5 * Math.PI) / 180;
	const ring = Math.floor(Math.sqrt(index)) * 280;
	return {
		x: Math.round((Math.cos(angle) * ring) / 4) * 4,
		y: Math.round((Math.sin(angle) * ring) / 4) * 4,
	};
};

const uniqueSessions = (
	sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<DiscoveredSession> =>
	[...new Map(sessions.map((session) => [session.identity, session])).values()].sort(
		(left, right) => left.identity.localeCompare(right.identity),
	);

const nodeFrom = (session: DiscoveredSession, index: number): SessionCanvasNode => ({
	id: session.identity,
	type: "session",
	position: positionFor(index),
	ariaLabel: `${sessionTitle(session.cwd)} oturumu, ${session.piSessionId}`,
	data: {session, title: sessionTitle(session.cwd)},
});

export const toSessionNodes = (
	sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<SessionCanvasNode> => uniqueSessions(sessions).map(nodeFrom);

export const reconcileSessionNodes = (
	current: ReadonlyArray<SessionCanvasNode>,
	sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<SessionCanvasNode> => {
	const previous = new Map(current.map((node) => [node.id, node]));
	return uniqueSessions(sessions).map((session, index) => {
		const node = previous.get(session.identity);
		const next = nodeFrom(session, index);
		return node === undefined
			? next
			: {
					...node,
					ariaLabel: next.ariaLabel ?? node.ariaLabel ?? next.data.title,
					data: next.data,
				};
	});
};

export const toRelationshipEdges = (
	sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<SessionRelationshipEdge> => {
	return sessions.flatMap((session) => {
		if (session.parentSessionId === undefined) return [];
		const parent = sessions.find((candidate) => candidate.piSessionId === session.parentSessionId);
		if (parent === undefined) return [];
		const parentIdentity = parent.identity;
		return [
			{
				id: `relationship:${parentIdentity}:${session.identity}`,
				type: "relationship" as const,
				source: parentIdentity,
				target: session.identity,
				sourceHandle: "relation-out",
				targetHandle: "relation-in",
				ariaLabel: `${session.parentSessionId} oturumundan ${session.piSessionId} oturumuna ilişki`,
				data: {},
			},
		];
	});
};

export const reconcileRelationshipEdges = (
	current: ReadonlyArray<SessionRelationshipEdge>,
	sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<SessionRelationshipEdge> => {
	const previous = new Map(current.map((edge) => [edge.id, edge]));
	return toRelationshipEdges(sessions).map((next) => {
		const edge = previous.get(next.id);
		return edge === undefined ? next : {...edge, ...next, data: next.data ?? {}};
	});
};
