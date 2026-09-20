/**
 * What a restored process says about itself, end to end on a real kernel (#8812).
 *
 * Driven through two boots over one set of stores rather than through the compiled row alone,
 * because the thing under test is exactly what the row cannot show: the latch is per-process
 * runtime memory the second boot starts empty, the rehydrating `init` answers no Cmds, and the
 * authored `update` publishes a line only when it moves. The restored title is read off the process
 * table with nothing dispatched into the process, which is the whole claim.
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
import type {SelfReport} from "../process/self-report.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";

interface Counted {
	readonly count: number;
}

const titledId = ProgramId.make("restored-self-report-titled");
const silentId = ProgramId.make("restored-self-report-silent");

/** Both lines as functions of state, so a restore has something to read off the loaded state. */
const titled = defineProgram({
	id: titledId,
	init: (): Counted => ({count: 0}),
	title: (state: Counted) => `counted ${state.count}`,
	status: () => "steady",
	update: {bump: (state: Counted) => [{count: state.count + 1}, []]},
});

/** The same program deriving neither line: it owes the restore path nothing. */
const silent = defineProgram({
	id: silentId,
	init: (): Counted => ({count: 0}),
	update: {bump: (state: Counted) => [{count: state.count + 1}, []]},
});

const kernel = (stores: CheckpointStores) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer([titled, silent]), Checkpoints.layer(stores))),
	);

/**
 * Boot each program fresh and move it once, so a snapshot exists to come back from and the title
 * the process last published is the one its saved state derives.
 */
const firstBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const processes = yield* Processes;
		const reports: Array<readonly [ProgramId, SelfReport]> = [];
		for (const program of [titledId, silentId]) {
			const id = yield* spawned.spawn(program, Option.none());
			const handle = Option.getOrThrow(yield* processes.handle(id));
			yield* handle.dispatch({type: "bump"});
			reports.push([program, (yield* ProcessTable.use((table) => table.get(id))).selfReport()]);
		}
		return reports;
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

/** Bring them back and read the table without dispatching anything into either process. */
const secondBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		yield* restore(Context.empty());
		const rows = yield* ProcessTable.use((table) => table.list);
		return rows.map(
			(row) =>
				[row.programId, row.selfReport(), row.id] as readonly [ProgramId, SelfReport, ProcessId],
		);
	}).pipe(Effect.provide(kernel(stores)), Effect.orDie);

const reportOf = (
	rows: ReadonlyArray<readonly [ProgramId, SelfReport, ...ReadonlyArray<unknown>]>,
	program: ProgramId,
): SelfReport => {
	const found = rows.find(([id]) => id === program);
	assert.isDefined(found, `no row for ${program}`);
	return found![1];
};

describe("the self-report a restored process reads back", () => {
	it.effect("carries the line its loaded state derives, before any transition reaches it", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const before = yield* firstBoot(stores);
			// The line the process last published, and the one its checkpointed state still derives:
			// the restore has nothing to move, which is the case that used to read back as untitled.
			assert.deepStrictEqual(reportOf(before, titledId), {
				title: Option.some("counted 1"),
				status: Option.some("steady"),
			});

			const after = yield* secondBoot(stores);
			assert.deepStrictEqual(reportOf(after, titledId), {
				title: Option.some("counted 1"),
				status: Option.some("steady"),
			});
		}),
	);

	it.effect("stays empty for a program that derives neither line", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			yield* firstBoot(stores);
			const after = yield* secondBoot(stores);
			assert.deepStrictEqual(reportOf(after, silentId), {
				title: Option.none(),
				status: Option.none(),
			});
			assert.isUndefined(silent.derivedLines);
		}),
	);
});
