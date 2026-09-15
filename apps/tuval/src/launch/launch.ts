/**
 * Launch runs a compiled graph: one process per node, spawned at the node's own id, under the
 * node's parent, with the wiring bound to it both ways — its handlers get a `ProcessPorts` that
 * emits from this node, and every in-port gets a pump that takes from the port's queue and
 * dispatches through the program's receiver. A node whose id is already checkpointed comes back
 * at its saved state, because the spawn opens that checkpoint like any other; nothing here is a
 * second restore path. Every refusal — a receiver missing for a declared in-port — fires before
 * the first spawn.
 *
 * The spawn and the pumping go through `SpawnedProcesses.adopt` (`../commands/core/process.ts`)
 * rather than through `Processes.spawn` and a pump of this module's own (#8944). This module used
 * to carry that pump, and a process it launched was therefore invisible to the `process` spells:
 * `send` and `read` answer off the table `adopt` now enrols into, so a planned program's in-port
 * was dead surface from the command line and from any agent. One table, one pump, and a node's
 * out-port latch is opened by the same code that opens an ad-hoc process's.
 */

import {Context, Effect, Option, type Queue} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {dispatchResume} from "../durability/resume.ts";
import type {CompiledGraph, CompiledNode} from "../ports/graph.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import type {Wiring} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {NoReceiver} from "./errors.ts";

export interface LaunchedProcess {
	readonly node: CompiledNode["id"];
	readonly handle: ProcessHandle;
	/** The node's checkpoint existed before this launch, so the process is back at its saved state. */
	readonly restored: boolean;
}

export interface LaunchOptions {
	/**
	 * Provided to every launched process's handlers beside its own `ProcessPorts`. A program row's
	 * `R` is the kernel's to satisfy, and `boot` passes the kernel context here: the shell's Cmds
	 * spawn processes and read the process table, and this is the only seam those services can
	 * arrive through, since `SpawnOptions.services` is per-process and this is what spawns a planned
	 * node. Local program code is fully trusted (#7484 R1.1), so this is wiring, not a grant.
	 */
	readonly services?: Context.Context<never>;
}

/** One node with its registry row, resolved and checked before anything is spawned. */
interface Planned {
	readonly node: CompiledNode;
	readonly row: AnyProgram;
}

export const launch = Effect.fn("Tuval.launch")(function* (
	compiled: CompiledGraph,
	wiring: Wiring,
	options?: LaunchOptions,
) {
	const registry = yield* Registry;
	const processes = yield* Processes;
	const spawned = yield* SpawnedProcesses;
	const checkpoints = yield* Checkpoints;

	const rows = new Map<CompiledNode["id"], AnyProgram>();
	const planned: Planned[] = [];
	for (const node of compiled.nodes) {
		const row = yield* registry.resolve(node.program);
		for (const port of Object.keys(node.inPorts)) {
			if (row.receive?.[port] === undefined) {
				return yield* new NoReceiver({node: node.id, program: node.program, port});
			}
		}
		rows.set(node.id, row);
		planned.push({node, row});
	}

	const checkpointed = new Set((yield* checkpoints.list).map((entry) => entry.id));
	const launched: LaunchedProcess[] = [];
	for (const {node, row} of planned) {
		const id = ProcessId.make(node.id);
		const parent = Option.map(node.parent, ProcessId.make);
		// The wiring's own queues, handed over rather than copied: a node's in-port is a route's
		// target and a `process send` target at once, and two queues would be two halves of one port.
		const inboxes = new Map<string, Queue.Queue<unknown>>();
		for (const port of Object.keys(node.inPorts)) {
			inboxes.set(port, yield* wiring.inbox({node: node.id, port}));
		}
		const handle = yield* spawned.adopt({
			process: id,
			program: row,
			inboxes,
			emit: (port, payload) => wiring.emit({node: node.id, port}, payload),
			start: (ports) =>
				processes.spawn(node.program, {
					id,
					...(Option.isSome(parent) ? {parent: parent.value} : {}),
					services: Context.merge(
						options?.services ?? Context.empty(),
						Context.make(ProcessPorts, ports),
					),
				}),
		});
		launched.push({node: node.id, handle, restored: checkpointed.has(id)});
	}
	// After every node is spawned and pumped, never inside the loop: a resume republishes on its
	// out-ports, and a node whose reader has not been launched yet would publish into a queue no
	// process is draining.
	for (const process of launched) {
		if (!process.restored) continue;
		yield* dispatchResume(rows.get(process.node), process.handle);
	}
	return launched as ReadonlyArray<LaunchedProcess>;
});
