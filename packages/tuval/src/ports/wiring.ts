/**
 * The delivery half: one Effect queue per in-port of a compiled graph, built with the bound the
 * port declared, and `emit` that offers a payload to every target of a route in compiled order.
 * An out-port has no queue of its own — it is the name delivery starts from — so a source's
 * message reaches each target's queue directly, in the order the routes were authored.
 */

import {Effect, Queue} from "effect";
import type {ProgramId} from "../registry/program.ts";
import {PayloadRejected, PortNotWired} from "./errors.ts";
import type {CompiledGraph, CompiledRoute, NodeId, PortRef} from "./graph.ts";

export interface Delivery {
	readonly to: PortRef;
	/** `false` only under `dropping` overflow: the target was full and refused this payload. */
	readonly accepted: boolean;
}

export interface Wiring {
	/** Offer `payload` on `from`'s out-port to every routed target, in compiled route order. */
	readonly emit: (
		from: PortRef,
		payload: unknown,
	) => Effect.Effect<ReadonlyArray<Delivery>, PayloadRejected | PortNotWired>;
	/**
	 * The queue behind an in-port. The process that owns the node takes from it, and `process send`
	 * offers to it: a graph node's in-port is a route's target and a spell's target at once, so the
	 * whole queue is handed over rather than the take half (#8944). Narrowing it back to a `Dequeue`
	 * would mean a second queue for the spell, which is two halves of one port.
	 */
	readonly inbox: (at: PortRef) => Effect.Effect<Queue.Queue<unknown>, PortNotWired>;
}

const key = ({node, port}: PortRef) => `${node}\u0000${port}`;

interface Target {
	readonly route: CompiledRoute;
	readonly queue: Queue.Queue<unknown>;
	readonly accepts: (payload: unknown) => boolean;
}

/** Scoped: every queue is shut down when the scope closes, so a wiring never outlives its owner. */
export const open = Effect.fn("Tuval.ports.open")(function* (compiled: CompiledGraph) {
	const inboxes = new Map<string, Queue.Queue<unknown>>();
	const accepts = new Map<string, (payload: unknown) => boolean>();
	const programs = new Map<NodeId, ProgramId>();
	for (const node of compiled.nodes) {
		programs.set(node.id, node.program);
		for (const [name, port] of Object.entries(node.inPorts)) {
			const queue = yield* Queue.make<unknown>({
				capacity: port.bound.capacity,
				strategy: port.bound.overflow,
			});
			yield* Effect.addFinalizer(() => Queue.shutdown(queue));
			const ref = {node: node.id, port: name};
			inboxes.set(key(ref), queue);
			accepts.set(key(ref), port.accepts);
		}
	}

	const targets = new Map<string, Target[]>();
	for (const route of compiled.routes) {
		const from = key(route.source);
		const to = key(route.target);
		const queue = inboxes.get(to);
		const accept = accepts.get(to);
		if (queue === undefined || accept === undefined) {
			return yield* Effect.die(`compiled route targets an in-port that was never opened: ${to}`);
		}
		targets.set(from, [...(targets.get(from) ?? []), {route, queue, accepts: accept}]);
	}

	const emit: Wiring["emit"] = Effect.fn("Tuval.ports.emit")(function* (from, payload) {
		const routed = targets.get(key(from));
		if (routed === undefined) {
			return yield* new PortNotWired(from);
		}
		const deliveries: Delivery[] = [];
		for (const {route, queue, accepts} of routed) {
			if (!accepts(payload)) {
				return yield* new PayloadRejected({
					node: route.target.node,
					program: route.target.program,
					port: route.target.port,
					kind: route.kind,
				});
			}
			const accepted = yield* Queue.offer(queue, payload);
			deliveries.push({to: {node: route.target.node, port: route.target.port}, accepted});
		}
		return deliveries;
	});

	const inbox: Wiring["inbox"] = (at) => {
		const queue = inboxes.get(key(at));
		return queue === undefined ? Effect.fail(new PortNotWired(at)) : Effect.succeed(queue);
	};

	return {emit, inbox} satisfies Wiring;
});
