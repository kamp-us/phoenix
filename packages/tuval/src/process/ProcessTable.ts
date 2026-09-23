import {Context, type Effect, type Stream} from "effect";
import type {ProcessNotFound} from "./errors.ts";
import type {ProcessChange, ProcessId, ProcessRow} from "./process.ts";

/**
 * The live set, in memory. Read-only from here: `Processes.layer` builds it over the same map it
 * spawns into and is the only writer. Publishing it as a port is `src/table/`'s.
 */
export class ProcessTable extends Context.Service<
	ProcessTable,
	{
		readonly list: Effect.Effect<ReadonlyArray<ProcessRow>>;
		readonly get: (id: ProcessId) => Effect.Effect<ProcessRow, ProcessNotFound>;
		/** Every change from the moment the stream runs; a `stopped` row has already left `list`. */
		readonly changes: Stream.Stream<ProcessChange>;
	}
>()("tuval/ProcessTable") {}
