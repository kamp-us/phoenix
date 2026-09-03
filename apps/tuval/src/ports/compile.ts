/**
 * Route compatibility, checked over registry rows before any process exists — which is what
 * "refused before boot" means. Nothing here spawns, opens a queue, or touches `src/process/`.
 */

import {Effect} from "effect";
import type {InPort, OutPort, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {
	DuplicateNodeId,
	IncompatibleRoute,
	InvalidBound,
	UndeclaredPort,
	UnknownNode,
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
		nodes.set(node.id, {id: node.id, program: node.program, inPorts});
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
	if (source.kind !== target.kind) {
		return yield* new IncompatibleRoute({
			source: {program: node.program, port, kind: source.kind},
			target: {program: targetNode.program, port: to.port, kind: target.kind},
		});
	}
	return {
		kind: source.kind,
		source: {node: node.id, port, program: node.program},
		target: {node: targetNode.id, port: to.port, program: targetNode.program},
	} satisfies CompiledRoute;
});
