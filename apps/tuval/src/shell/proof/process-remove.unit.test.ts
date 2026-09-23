/**
 * The epic's own claim, driven from the key (#9447/#8332): a desk with twenty stray `counter`
 * processes is cleared through the affordance, and a restart brings none of them back.
 *
 * Nothing here is a double. The kernel is the real `Processes` over the real `Checkpoints`, and
 * `memoryStores()` is a reload rather than a mock — `../../durability/stores.ts` keeps the stores in
 * a map precisely so a second kernel over the same object is a restart. The only input is the key:
 * `pickerKey` answers it, the shell's own reducer turns that answer's Msg into a Cmd, and
 * `wiredShellEffects` runs the Cmd. A test that called `Processes.remove` itself would prove the
 * kernel and skip the whole affordance.
 */

import {assert, describe, it} from "@effect/vitest";
import {Checkpoints} from "@kampus/tuval/kernel/durability/Checkpoints";
import {restore} from "@kampus/tuval/kernel/durability/restore";
import {type CheckpointStores, memoryStores} from "@kampus/tuval/kernel/durability/stores";
import {PlannedProcesses} from "@kampus/tuval/kernel/process/PlannedProcesses";
import {Processes} from "@kampus/tuval/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval/kernel/process/ProcessTable";
import type {ProcessId} from "@kampus/tuval/kernel/process/process";
import type {AnyProgram} from "@kampus/tuval/kernel/registry/program";
import {Registry} from "@kampus/tuval/kernel/registry/Registry";
import type {WindowId} from "@kampus/tuval/kernel/shell/window/host";
import {Context, Effect, Layer} from "effect";
import {toTableRow} from "../../table/row.ts";
import {applyMsg, initialState, type ShellMsg} from "../core/machine.ts";
import {activeWorkspace, type ShellState} from "../core/state.ts";
import {wiredShellEffects} from "../host/effects.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {type PickerEntries, processEntries, programEntries} from "../picker/entries.ts";
import {programRow, shellProcessId} from "../picker/fixtures.ts";
import {asPickerView, pickerKey} from "../picker/view.ts";

const STRAY_COUNT = 20;
const counter = programRow("counter", {label: "Counter"});
const rows: ReadonlyArray<AnyProgram> = [counter];

type Kernel = Processes | ProcessTable | PlannedProcesses | Registry | Checkpoints;

const kernel = (stores: CheckpointStores): Layer.Layer<Kernel> =>
	Processes.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(Registry.layer(rows).pipe(Layer.orDie), Checkpoints.layer(stores)),
		),
	);

/** The picker's two lists, read off the live table the way a mount reads them. */
const entriesNow = Effect.gen(function* () {
	const table = yield* ProcessTable;
	const live = yield* table.list;
	return {
		programs: programEntries(rows),
		processes: processEntries(rows, live.map(toTableRow)),
	} satisfies PickerEntries;
});

const focusedWindow = (state: ShellState): WindowId => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return workspace.focused as WindowId;
};

/**
 * One `d` press on the first process row, all the way down: the picker's answer, the reducer's Cmd,
 * and the shell's wired handler. It returns whatever Msgs the handler sent back, which is empty on a
 * removal that happened and one `window.setView` on a refusal.
 */
const pressRemove = Effect.fn("processRemove.pressRemove")(function* (
	state: ShellState,
	entries: PickerEntries,
) {
	const window = focusedWindow(state);
	// The cursor sits on the first process row: the programs come first in the flattened list.
	const view = {...asPickerView(state.views[window]), cursor: entries.programs.length};
	const answer = pickerKey(window, entries, view, "d", {processRemove: true});
	if (answer._tag !== "Removing") {
		return yield* Effect.die(new Error(`test setup: "d" answered ${answer._tag}`));
	}
	const msg: ShellMsg = {type: "process.remove", windowId: window, processId: answer.processId};
	const [next, cmds] = applyMsg(
		defaultPrefixTable,
		{...state, views: {...state.views, [window]: view}},
		msg,
	);
	const removal = cmds.find((cmd) => cmd.type === "removeProcess");
	if (removal === undefined || removal.type !== "removeProcess") {
		return yield* Effect.die(new Error("test setup: the reducer asked for no removal"));
	}
	const back = yield* wiredShellEffects({shellProcessId}).removeProcess(removal);
	return {
		asked: answer.processId,
		state: back.reduce((carried, sent) => applyMsg(defaultPrefixTable, carried, sent)[0], next),
		back,
	};
});

/** Spawn the strays, then clear every one of them through the key. */
const clearTheDesk = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		for (let made = 0; made < STRAY_COUNT; made += 1) {
			yield* processes.spawn(counter.id, {services: Context.empty()});
		}

		const before = yield* entriesNow;
		assert.lengthOf(before.processes, STRAY_COUNT);

		let state = initialState();
		const cleared: Array<ProcessId> = [];
		for (let step = 0; step < STRAY_COUNT; step += 1) {
			const entries = yield* entriesNow;
			const pressed = yield* pressRemove(state, entries);
			assert.deepStrictEqual(pressed.back, [], "a removal the kernel took writes no desk state");
			cleared.push(pressed.asked);
			state = pressed.state;
		}

		return {
			cleared,
			entries: yield* entriesNow,
			checkpointed: (yield* Checkpoints.use((checkpoints) => checkpoints.list)).map(
				(entry) => entry.id,
			),
		};
	}).pipe(Effect.provide(kernel(stores)), Effect.scoped, Effect.orDie);

describe("clearing a desk of twenty stray counters", () => {
	it.effect("empties the picker and the manifest, one `d` per row", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const run = yield* clearTheDesk(stores);

			assert.lengthOf(new Set(run.cleared), STRAY_COUNT, "each press named a different process");
			assert.deepStrictEqual(run.entries.processes, []);
			assert.deepStrictEqual(run.checkpointed, []);
			// The default row is untouched: the picker still offers the program to spawn.
			assert.deepStrictEqual(
				run.entries.programs.map((entry) => entry.programId),
				[counter.id],
			);
		}),
	);

	it.effect("brings none of them back on a restart, which is the epic's actual claim", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			yield* clearTheDesk(stores);

			const restarted = yield* Effect.gen(function* () {
				const handles = yield* restore(Context.empty());
				return {restored: handles.map((handle) => handle.id), entries: yield* entriesNow};
			}).pipe(Effect.provide(kernel(stores)), Effect.scoped, Effect.orDie);

			assert.deepStrictEqual(restarted.restored, []);
			assert.deepStrictEqual(restarted.entries.processes, []);
		}),
	);
});

describe("a graph-declared process", () => {
	it.effect("refuses the key, keeps running, and the window says to edit the config", () =>
		Effect.gen(function* () {
			const answer = yield* Effect.gen(function* () {
				const processes = yield* Processes;
				const planned = yield* PlannedProcesses;
				const spawned = yield* processes.spawn(counter.id, {services: Context.empty()});
				yield* planned.declare([spawned.id]);

				const state = initialState();
				const pressed = yield* pressRemove(state, yield* entriesNow);
				const window = focusedWindow(state);
				return {
					spawned: spawned.id,
					back: pressed.back,
					refusal: asPickerView(pressed.state.views[window]).refusal,
					entries: yield* entriesNow,
					checkpointed: (yield* Checkpoints.use((checkpoints) => checkpoints.list)).map(
						(entry) => entry.id,
					),
				};
			}).pipe(Effect.provide(kernel(memoryStores())), Effect.scoped, Effect.orDie);

			assert.deepStrictEqual(answer.refusal, {
				_tag: "ProcessPlanned",
				processId: answer.spawned,
			});
			assert.lengthOf(answer.back, 1);
			// Refused whole: the process is still in the picker and still in the manifest.
			assert.deepStrictEqual(
				answer.entries.processes.map((entry) => entry.processId),
				[answer.spawned],
			);
			assert.deepStrictEqual(answer.checkpointed, [answer.spawned]);
		}),
	);
});
