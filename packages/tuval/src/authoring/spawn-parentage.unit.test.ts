/**
 * The parent edge a program-spawned child carries, end to end on a real kernel (#8757).
 *
 * Driven through a spawned process rather than the handler alone, because the thing under test is
 * exactly what the handler cannot fake: `ProcessSelf.id` is the kernel's, provided at the one
 * `Processes.spawn` every path goes through, and the child's parent is read back off the process
 * table rather than off the value the handler passed.
 *
 * The second boot is the other half of the same claim: the edge is written into the checkpoint
 * manifest, so a restore brings the child back still naming its spawner.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {restore} from "../durability/restore.ts";
import {type CheckpointStores, memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";
import {spawn} from "./effect.ts";

const childId = ProgramId.make("spawn-parentage-child");
const parentId = ProgramId.make("spawn-parentage-parent");

const child = defineProgram({
	id: childId,
	init: () => ({}),
	update: {},
});

/** One authored cell whose whole answer is a `spawn`, which is the effect this edge rides on. */
const parent = defineProgram({
	id: parentId,
	init: (): {readonly spawns: number} => ({spawns: 0}),
	update: {
		hatch: (state: {readonly spawns: number}) => [
			{spawns: state.spawns + 1},
			[spawn({programId: childId, out: {}})],
		],
	},
});

const kernel = (stores: CheckpointStores) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer([parent, child]), Checkpoints.layer(stores))),
	);

/** Spawn the parent as a root, then make it hatch. The rows it left behind are the answer. */
const firstBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const parentProcess = yield* spawned.spawn(parentId, Option.none());
		const handle = Option.getOrThrow(
			yield* Processes.use((kernel) => kernel.handle(parentProcess)),
		);
		yield* handle.dispatch({type: "hatch"});
		const rows = yield* ProcessTable.use((table) => table.list);
		return {parentProcess, rows: rows.map((row) => ({id: row.id, parentId: row.parentId}))};
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

const secondBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		yield* restore(Context.empty());
		const rows = yield* ProcessTable.use((table) => table.list);
		return rows.map((row) => ({id: row.id, parentId: row.parentId}));
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

const childRowOf = (
	rows: ReadonlyArray<{readonly id: ProcessId; readonly parentId: Option.Option<ProcessId>}>,
	parentProcess: ProcessId,
) => {
	const found = rows.filter((row) => row.id !== parentProcess);
	assert.strictEqual(found.length, 1, "exactly one child was spawned");
	return found[0]!;
};

describe("a program-spawned child's parent", () => {
	it.effect("is the process the spawn was interpreted for", () =>
		Effect.gen(function* () {
			const stores = memoryStores();

			const {parentProcess, rows} = yield* firstBoot(stores);

			assert.deepStrictEqual(childRowOf(rows, parentProcess).parentId, Option.some(parentProcess));
		}),
	);

	it.effect("survives a restore", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const {parentProcess} = yield* firstBoot(stores);

			const rows = yield* secondBoot(stores);

			assert.deepStrictEqual(childRowOf(rows, parentProcess).parentId, Option.some(parentProcess));
		}),
	);
});
