import {Context, type Effect} from "effect";
import type {ProcessNotFound} from "./errors.ts";
import type {ProcessId, ProcessRow} from "./process.ts";

/**
 * The live set, in memory. Read-only from here: `Processes.layer` builds it over the same map it
 * spawns into and is the only writer. Publishing it as a port is the process-table-port slice's.
 */
export class ProcessTable extends Context.Service<
	ProcessTable,
	{
		readonly list: Effect.Effect<ReadonlyArray<ProcessRow>>;
		readonly get: (id: ProcessId) => Effect.Effect<ProcessRow, ProcessNotFound>;
	}
>()("tuval/ProcessTable") {}
