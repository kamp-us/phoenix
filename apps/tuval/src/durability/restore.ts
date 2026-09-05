import {Context, Effect} from "effect";
import type {DispatchError} from "../host/actor.ts";
import type {StoreError} from "../host/errors.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/ProcessPorts.ts";
import type {HandlerFailed} from "../process/errors.ts";
import {Processes, type SpawnError} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type ProcessHandle, ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import type {ManifestMalformed} from "./errors.ts";
import {dispatchResume} from "./resume.ts";

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
 *
 * Once every spawn is done, each one is handed the resume Msgs its own row declares — the last
 * step of a restore, and the one nothing outside a test used to take (#7877).
 */
export const restore = (
	services: Context.Context<never>,
): Effect.Effect<
	ReadonlyArray<ProcessHandle>,
	SpawnError | ManifestMalformed | StoreError | DispatchError<HandlerFailed>,
	Checkpoints | Processes | ProcessTable | Registry
> =>
	Effect.gen(function* () {
		const checkpoints = yield* Checkpoints;
		const processes = yield* Processes;
		const table = yield* ProcessTable;
		const registry = yield* Registry;
		const live = new Set((yield* table.list).map((row) => row.id));
		const spawned: Array<{readonly programId: ProgramId; readonly handle: ProcessHandle}> = [];
		for (const entry of yield* checkpoints.list) {
			const id = ProcessId.make(entry.id);
			if (live.has(id)) continue;
			const programId = ProgramId.make(entry.programId);
			spawned.push({
				programId,
				handle: yield* processes.spawn(programId, {
					id,
					...(entry.parentId === null ? {} : {parent: ProcessId.make(entry.parentId)}),
					services: Context.merge(services, Context.make(ProcessPorts, unwired(NodeId.make(id)))),
				}),
			});
		}
		for (const process of spawned) {
			yield* dispatchResume(yield* registry.resolve(process.programId), process.handle);
		}
		return spawned.map((process) => process.handle);
	}).pipe(Effect.withSpan("Tuval.durability.restore"));
