/**
 * Restore's `ProcessPorts`, over the two boots that make it visible (#7789): a process the picker
 * spawned is no graph node, so `restore` is the only thing that brings it back, and what it brings
 * back has to carry what its handlers require. It runs on the demo counter, whose `announce` both
 * requires that service and emits on it. The kernel context a restored process gets (#7951) is
 * proven through the real boot, in `./boot-restore-context.unit.test.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {restore} from "@kampus/tuval-sdk/kernel/durability/restore";
import {type CheckpointStores, memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {PortNotWired} from "@kampus/tuval-sdk/kernel/ports/errors";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {HandlerFailed} from "@kampus/tuval-sdk/kernel/process/errors";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Context, Effect, Layer, Option} from "effect";
import {counterId, counterProgram} from "../demo/counter.ts";

const counterRows = [counterProgram({everyMs: null})];

/** One boot's kernel; the state dir is the caller's, so two of these share what was checkpointed. */
const kernel = (stores: CheckpointStores, rows: ReadonlyArray<AnyProgram>) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(stores))),
	);

/** The picker's spawn path: a process under no node, checkpointed, then left for the next boot. */
const firstBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		return yield* spawned.spawn(counterId, Option.none());
	}).pipe(Effect.provide(kernel(stores, counterRows)), Effect.orDie);

/**
 * The second boot: restore, then tick the process back. `announce` is a Cmd handler, so what its
 * emit fails with reaches the dispatcher wrapped in `HandlerFailed`.
 */
const secondBoot = (id: ProcessId, stores: CheckpointStores) =>
	Effect.gen(function* () {
		const restored = yield* restore(Context.empty());
		assert.deepStrictEqual(
			restored.map((handle) => handle.id),
			[id],
		);
		const handle = restored[0]!;
		const raised = yield* handle.dispatch({type: "tick"}).pipe(Effect.flip);
		assert.instanceOf(raised, HandlerFailed);
		const failure = raised as HandlerFailed;
		const live = yield* ProcessTable.use((table) => table.list);
		return {failure, state: handle.getState(), live: live.map((row) => row.id)};
	}).pipe(Effect.provide(kernel(stores, counterRows)), Effect.orDie);

describe("restore's services", () => {
	it.effect("a picker-spawned process comes back with the ProcessPorts its handler requires", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const id = yield* firstBoot(stores);

			const {failure, state, live} = yield* secondBoot(id, stores);

			// Reaching the emit is the proof the service was there: before #7789 the handler died on
			// the empty context restore spawned it with, one step earlier.
			assert.strictEqual(failure.programId, counterId);
			assert.strictEqual(failure.cmdType, "announce");
			assert.deepStrictEqual(state, {count: 1});
			assert.deepStrictEqual(live, [id]);
			// Its emit fails PortNotWired naming the restored process and the port.
			const cause = failure.cause as PortNotWired;
			assert.instanceOf(cause, PortNotWired);
			assert.strictEqual(cause.node, NodeId.make(id));
			assert.strictEqual(cause.port, "ticks");
			assert.include(cause.message, "ticks");
		}),
	);
});
