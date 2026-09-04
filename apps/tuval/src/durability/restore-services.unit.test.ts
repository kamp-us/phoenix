/**
 * Restore's services half (#7789), over the two boots that make it visible: a process the picker
 * spawned is no graph node, so `restore` is the only thing that brings it back, and what it brings
 * back has to carry the `ProcessPorts` its handlers require. The fixture is the demo counter, whose
 * `announce` both requires that service and emits on it.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {counterId, counterProgram} from "../demo/counter.ts";
import {PortNotWired} from "../ports/errors.ts";
import {NodeId} from "../ports/graph.ts";
import {HandlerFailed} from "../process/errors.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {ProcessId} from "../process/process.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {restore} from "./restore.ts";
import {type CheckpointStores, memoryStores} from "./stores.ts";

const rows = [counterProgram({everyMs: null})];

/** One boot's kernel; the state dir is the caller's, so two of these share what was checkpointed. */
const kernel = (stores: CheckpointStores) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(stores))),
	);

/** The picker's spawn path: a process under no node, checkpointed, then left for the next boot. */
const firstBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		return yield* spawned.spawn(counterId, Option.none());
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

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
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

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
			assert.instanceOf(failure.cause, PortNotWired);
			assert.deepStrictEqual(state, {count: 1});
			assert.deepStrictEqual(live, [id]);
		}),
	);

	it.effect("its emit fails PortNotWired naming the restored process and the port", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const id = yield* firstBoot(stores);

			const {failure} = yield* secondBoot(id, stores);

			const cause = failure.cause as PortNotWired;
			assert.instanceOf(cause, PortNotWired);
			assert.strictEqual(cause.node, NodeId.make(id));
			assert.strictEqual(cause.port, "ticks");
			assert.include(cause.message, "ticks");
		}),
	);
});
