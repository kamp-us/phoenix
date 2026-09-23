/**
 * Route compatibility, checked over registry rows before any process exists — which is what
 * "refused before boot" means. Nothing here spawns, opens a queue, or touches `src/process/`.
 *
 * A route compiles on payload fit, not on the port kind. `whyNotRouted` below states the rule in
 * full; why it is that rule, and what it replaced, is ADR 0395 (#8923).
 */

import {Effect, Option} from "effect";
import {describeDifference, payloadDifference, payloadFits} from "../registry/payload-fit.ts";
import type {InPort, OutPort, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {
	DuplicateNodeId,
	IncompatibleRoute,
	InvalidBound,
	UndeclaredPort,
	UnknownNode,
	UnknownParent,
} from "./errors.ts";
import type {
	CompiledGraph,
	CompiledNode,
	CompiledRoute,
	Graph,
	GraphNode,
	PortRef,
} from "./graph.ts";

export const compile = Effect.fn("Tuval.ports.compile")(function* (graph: Graph) {
	const registry = yield* Registry;
	const nodes = new Map<string, CompiledNode>();
	const outPorts = new Map<string, Readonly<Record<string, OutPort>>>();

	for (const node of graph.nodes) {
		if (nodes.has(node.id)) {
			return yield* new DuplicateNodeId({node: node.id});
		}
		if (node.parent !== undefined && !nodes.has(node.parent)) {
			return yield* new UnknownParent({node: node.id, parent: node.parent});
		}
		const row = yield* registry.resolve(node.program);
		const inPorts: Record<string, InPort> = {};
		const outs: Record<string, OutPort> = {};
		for (const [name, port] of Object.entries(row.ports)) {
			if (port.direction === "in") {
				yield* checkBound(node.program, name, port);
				inPorts[name] = port;
			} else {
				outs[name] = port;
			}
		}
		nodes.set(node.id, {
			id: node.id,
			program: node.program,
			parent: Option.fromNullishOr(node.parent),
			inPorts,
		});
		outPorts.set(node.id, outs);
	}

	const routes: CompiledRoute[] = [];
	for (const node of graph.nodes) {
		for (const route of node.on) {
			routes.push(yield* resolveRoute(node, route.port, route.to, nodes, outPorts));
		}
	}

	return {nodes: [...nodes.values()], routes} satisfies CompiledGraph;
});

const checkBound = (program: ProgramId, port: string, {bound}: InPort) =>
	Number.isInteger(bound.capacity) && bound.capacity > 0
		? Effect.void
		: new InvalidBound({program, port, capacity: bound.capacity});

const resolveRoute = Effect.fn("Tuval.ports.resolveRoute")(function* (
	node: GraphNode,
	port: string,
	to: PortRef,
	nodes: ReadonlyMap<string, CompiledNode>,
	outPorts: ReadonlyMap<string, Readonly<Record<string, OutPort>>>,
) {
	const source = outPorts.get(node.id)?.[port];
	if (source === undefined) {
		return yield* new UndeclaredPort({program: node.program, port, direction: "out"});
	}
	const targetNode = nodes.get(to.node);
	if (targetNode === undefined) {
		return yield* new UnknownNode({from: node.id, to: to.node});
	}
	const target = targetNode.inPorts[to.port];
	if (target === undefined) {
		return yield* new UndeclaredPort({program: targetNode.program, port: to.port, direction: "in"});
	}
	const refusal = whyNotRouted(
		source,
		`${node.program}.${port}`,
		target,
		`${targetNode.program}.${to.port}`,
	);
	if (refusal !== undefined) {
		return yield* new IncompatibleRoute({
			source: {program: node.program, port, kind: source.kind},
			target: {program: targetNode.program, port: to.port, kind: target.kind},
			reason: refusal,
		});
	}
	return {
		// The target's: what the payload is checked against on arrival, and what a `PayloadRejected`
		// naming that end is about. A structural route's two ends carry different kinds (`./graph.ts`).
		kind: target.kind,
		source: {node: node.id, port, program: node.program},
		target: {node: targetNode.id, port: to.port, program: targetNode.program},
	} satisfies CompiledRoute;
});

/**
 * Why these two ends may not be wired, or `undefined` when they may. Structural when both ends
 * published a schema, nominal when either did not — the two clauses of ADR 0395, in that order,
 * because a schema is the more truthful of the two and is only absent on a legacy row.
 */
const whyNotRouted = (
	source: OutPort,
	sourceEnd: string,
	target: InPort,
	targetEnd: string,
): string | undefined => {
	const {schema: carried} = source;
	const {schema: accepted} = target;
	if (carried === undefined || accepted === undefined) {
		return source.kind === target.kind
			? undefined
			: `kinds differ, no schema to compare: source kind "${source.kind}" does not match target kind "${target.kind}"`;
	}
	if (payloadFits(carried, accepted)) return undefined;
	const difference = payloadDifference(carried, accepted);
	return difference === undefined
		? `payload does not fit: ${sourceEnd} carries a different payload than ${targetEnd} accepts`
		: `payload does not fit: ${describeDifference(difference, sourceEnd, targetEnd)}`;
};
