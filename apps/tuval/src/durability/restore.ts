import {Context, Effect} from "effect";
import type {StoreError} from "../host/errors.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/ProcessPorts.ts";
import {Processes, type SpawnError} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type ProcessHandle, ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Checkpoints} from "./Checkpoints.ts";
import type {ManifestMalformed} from "./errors.ts";

/**
 * Boot's restore: spawn every checkpointed process back, in manifest order, at its saved id
 * and parent link. Each spawn opens its checkpoint, so a snapshot under another definition
 * fails the restore right there — loudly, with nothing fresh-booted in its place (#7467).
 * An entry already live — a planned process the launcher spawned back at its own id
 * (`src/launch/`) — is already restored, so it is left alone.
 *
 * `services` is the caller's ambient context for every process this brings back; each spawn also
 * gets a `ProcessPorts` of its own. What the graph does not own has no route to bind, so those
 * ports are `unwired`: the process comes back either way, and an emit fails `PortNotWired` at the
 * first call rather than dropping the payload (#7789).
 */
export const restore = (
	services: Context.Context<never>,
): Effect.Effect<
	ReadonlyArray<ProcessHandle>,
	SpawnError | ManifestMalformed | StoreError,
	Checkpoints | Processes | ProcessTable
> =>
	Effect.gen(function* () {
		const checkpoints = yield* Checkpoints;
		const processes = yield* Processes;
		const table = yield* ProcessTable;
		const live = new Set((yield* table.list).map((row) => row.id));
		const handles: ProcessHandle[] = [];
		for (const entry of yield* checkpoints.list) {
			const id = ProcessId.make(entry.id);
			if (live.has(id)) continue;
			handles.push(
				yield* processes.spawn(ProgramId.make(entry.programId), {
					id,
					...(entry.parentId === null ? {} : {parent: ProcessId.make(entry.parentId)}),
					services: Context.merge(services, Context.make(ProcessPorts, unwired(NodeId.make(id)))),
				}),
			);
		}
		return handles;
	}).pipe(Effect.withSpan("Tuval.durability.restore"));
