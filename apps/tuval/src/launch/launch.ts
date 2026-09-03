/**
 * Launch runs a compiled graph: one process per node, spawned at the node's own id, under the
 * node's parent, with the wiring bound to it both ways — its handlers get a `ProcessPorts` that
 * emits from this node, and every in-port gets a pump that takes from the port's queue and
 * dispatches through the program's receiver. A node whose id is already checkpointed comes back
 * at its saved state, because the spawn opens that checkpoint like any other; nothing here is a
 * second restore path. Every refusal — a receiver missing for a declared in-port — fires before
 * the first spawn.
 */

import {Context, Effect, Option, Queue} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import type {CompiledGraph, CompiledNode} from "../ports/graph.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import type {Wiring} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {type Message, type ProcessHandle, ProcessId} from "../process/process.ts";
import type {Receiver} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {NoReceiver} from "./errors.ts";

export interface LaunchedProcess {
	readonly node: CompiledNode["id"];
	readonly handle: ProcessHandle;
	/** The node's checkpoint existed before this launch, so the process is back at its saved state. */
	readonly restored: boolean;
}

export const launch = Effect.fn("Tuval.launch")(function* (
	compiled: CompiledGraph,
	wiring: Wiring,
) {
	const registry = yield* Registry;
	const processes = yield* Processes;
	const checkpoints = yield* Checkpoints;

	const receivers = new Map<CompiledNode["id"], Readonly<Record<string, Receiver<Message>>>>();
	for (const node of compiled.nodes) {
		const row = yield* registry.resolve(node.program);
		const receive = (row.receive ?? {}) as Readonly<Record<string, Receiver<Message>>>;
		for (const port of Object.keys(node.inPorts)) {
			if (receive[port] === undefined) {
				return yield* new NoReceiver({node: node.id, program: node.program, port});
			}
		}
		receivers.set(node.id, receive);
	}

	const checkpointed = new Set((yield* checkpoints.list).map((entry) => entry.id));
	const launched: LaunchedProcess[] = [];
	for (const node of compiled.nodes) {
		const id = ProcessId.make(node.id);
		const parent = Option.map(node.parent, ProcessId.make);
		const ports = ProcessPorts.of({
			emit: (port, payload) => wiring.emit({node: node.id, port}, payload),
		});
		const handle = yield* processes.spawn(node.program, {
			id,
			...(Option.isSome(parent) ? {parent: parent.value} : {}),
			services: Context.make(ProcessPorts, ports),
		});
		const receive = receivers.get(node.id) ?? {};
		for (const port of Object.keys(node.inPorts)) {
			const inbox = yield* wiring.inbox({node: node.id, port});
			yield* pump(handle, inbox, receive[port] as Receiver<Message>);
		}
		launched.push({node: node.id, handle, restored: checkpointed.has(id)});
	}
	return launched as ReadonlyArray<LaunchedProcess>;
});

/**
 * One in-port's pump: take, translate, dispatch, in queue order, for as long as the process
 * lives — the fiber is forked into the process Scope, so a stop interrupts it before the actor
 * drains. A dispatch the target refuses is the target's failure, reported and not retried.
 */
const pump = (handle: ProcessHandle, inbox: Queue.Dequeue<unknown>, receive: Receiver<Message>) =>
	Effect.forkIn(
		Effect.forever(
			Queue.take(inbox).pipe(
				Effect.flatMap((payload) => handle.dispatch(receive(payload as never))),
				Effect.catch((error: unknown) => Effect.logError(error)),
			),
		),
		handle.scope,
	);
