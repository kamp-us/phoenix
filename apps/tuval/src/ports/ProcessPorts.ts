/**
 * The wiring as one running process sees it: emit on its own out-ports by name, and nothing
 * else. A program's Cmd handler requires this service and never a node id or the `Wiring`, so
 * which node it is running as stays the launcher's knowledge (`src/launch/`), which provides
 * one of these per process at spawn.
 */

import {Context, type Effect} from "effect";
import type {PayloadRejected, PortNotWired} from "./errors.ts";
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
