/**
 * The authored `stop` effect forgets the child durably (#9220, folded into #9446).
 *
 * The shape is a `cron`: a program that spawns a worker, sees it through, and stops it — over and
 * over. `stop` used to close the child's Scope and leave its manifest row and snapshot behind, so
 * every completed job left one process for the next boot to bring back, and a long-lived scheduler
 * restored a queue of dead workers. The proof is therefore a second kernel over the same stores: run
 * three jobs, restart, and the scheduler is the only thing that comes back.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {restore} from "../durability/restore.ts";
import {type CheckpointStores, memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";
import {type Spawned, spawn, stop} from "./effect.ts";

const workerId = ProgramId.make("cron-worker");
const cronId = ProgramId.make("cron");

const worker = defineProgram({
	id: workerId,
	init: (): {readonly ticks: number} => ({ticks: 0}),
	update: {},
});

interface CronState {
	/** The worker running this job, if one is. */
	readonly running: ProcessId | null;
	readonly finished: number;
}

/** Spawn a worker per job, then end it — the whole of the shape that used to leak (#9220). */
const cron = defineProgram({
	id: cronId,
	init: (): CronState => ({running: null, finished: 0}),
	update: {
		job: (state: CronState) => [state, [spawn({programId: workerId, out: {}})]],
		spawned: (state: CronState, event: Spawned) => [
			{...state, running: ProcessId.make(event.process)},
			[],
		],
		done: (state: CronState) =>
			state.running === null
				? [state, []]
				: [{running: null, finished: state.finished + 1}, [stop(state.running)]],
	},
});

const kernel = (stores: CheckpointStores) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer([cron, worker]), Checkpoints.layer(stores))),
	);

/** Three jobs, each spawned and then ended through the authored `stop`. */
const runJobs = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const scheduler = yield* spawned.spawn(cronId, Option.none());
		const handle = Option.getOrThrow(yield* Processes.use((kernel) => kernel.handle(scheduler)));
		for (const _ of [1, 2, 3]) {
			yield* handle.dispatch({type: "job"});
			yield* handle.dispatch({type: "done"});
		}
		return {
			scheduler,
			finished: (handle.getState() as CronState).finished,
			checkpointed: (yield* Checkpoints.use((checkpoints) => checkpoints.list)).map(
				(entry) => entry.id,
			),
			live: (yield* ProcessTable.use((table) => table.list)).map((row) => row.id),
		};
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

describe("an authored `stop`", () => {
	it.effect("leaves the child in neither the manifest nor the table", () =>
		Effect.gen(function* () {
			const stores = memoryStores();

			const first = yield* runJobs(stores);

			assert.strictEqual(first.finished, 3);
			assert.deepStrictEqual(first.checkpointed, [first.scheduler as string]);
			assert.deepStrictEqual(first.live, [first.scheduler]);
		}),
	);

	it.effect("accumulates no restored process across a restart", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const first = yield* runJobs(stores);

			const restored = yield* Effect.gen(function* () {
				const handles = yield* restore(Context.empty());
				return handles.map((handle) => handle.id);
			}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

			assert.deepStrictEqual(restored, [first.scheduler]);
		}),
	);
});
