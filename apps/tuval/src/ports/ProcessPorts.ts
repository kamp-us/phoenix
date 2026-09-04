/**
 * The wiring as one running process sees it: emit on its own out-ports by name, and nothing
 * else. A program's Cmd handler requires this service and never a node id or the `Wiring`, so
 * which node it is running as stays its spawner's knowledge.
 *
 * Two spawners provide one per process. `src/launch/` binds a graph node's to the wiring, and
 * `src/commands/core/process.ts` binds a picker-spawned process's to that process's latches. A
 * process the graph does not own comes back through `src/durability/restore.ts`, which has no
 * routes to bind it to and hands it `unwired` below: every emit fails `PortNotWired` at the port
 * it named, so the process learns it has nowhere to talk at its first emit rather than losing the
 * payload to a silent no-op (#7789).
 */

import {Context, Effect} from "effect";
import {type PayloadRejected, PortNotWired} from "./errors.ts";
import type {NodeId} from "./graph.ts";
import type {Delivery} from "./wiring.ts";

export class ProcessPorts extends Context.Service<
	ProcessPorts,
	{
		readonly emit: (
			port: string,
			payload: unknown,
		) => Effect.Effect<ReadonlyArray<Delivery>, PayloadRejected | PortNotWired>;
	}
>()("tuval/ProcessPorts") {}

/** The ports of a process no wiring reaches: `emit` fails `PortNotWired` naming `node` and the port. */
export const unwired = (node: NodeId): Context.Service.Shape<typeof ProcessPorts> =>
	ProcessPorts.of({emit: (port) => Effect.fail(new PortNotWired({node, port}))});
