import {Effect} from "effect";
import type {StoreError} from "../host/errors.ts";
import {Processes, type SpawnError} from "../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Checkpoints} from "./Checkpoints.ts";
import type {ManifestMalformed} from "./errors.ts";

/**
 * Boot's restore: spawn every checkpointed process back, in manifest order, at its saved id
 * and parent link. Each spawn opens its checkpoint, so a snapshot under another definition
 * fails the restore right there — loudly, with nothing fresh-booted in its place (#7467).
 */
export const restore: Effect.Effect<
	ReadonlyArray<ProcessHandle>,
	SpawnError | ManifestMalformed | StoreError,
	Checkpoints | Processes
> = Effect.gen(function* () {
	const checkpoints = yield* Checkpoints;
	const processes = yield* Processes;
	const handles: ProcessHandle[] = [];
	for (const entry of yield* checkpoints.list) {
		const id = ProcessId.make(entry.id);
		const options = entry.parentId === null ? {id} : {id, parent: ProcessId.make(entry.parentId)};
		handles.push(yield* processes.spawn(ProgramId.make(entry.programId), options));
	}
	return handles;
}).pipe(Effect.withSpan("Tuval.durability.restore"));
