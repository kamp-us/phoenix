/**
 * What a choice does. The two routes into `runPickerIntent` — a highlighted picker row and a
 * resolved command line — are driven separately here and compared against one another, because
 * "the same handler" is the claim this slice exists to keep and nothing in the types enforces it.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {AnyProgram} from "../../registry/program.ts";
import {readCommandLine} from "../commands/line.ts";
import type {ShellMsg} from "../core/machine.ts";
import {noEntries, type PickerEntries, programEntries} from "./entries.ts";
import {
	pickerHarness,
	processId,
	programId,
	programRow,
	shellProcessId,
	windowId,
} from "./fixtures.ts";
import type {PickerIntent} from "./intent.ts";
import {attachProcess, openProgram} from "./intent.ts";
import {runPickerIntent} from "./open.ts";
import {mountPicker, pickerKey} from "./view.ts";

const window = windowId("window-1");
const rows: ReadonlyArray<AnyProgram> = [
	programRow("counter", {label: "Counter"}),
	programRow("indexer", {renderer: false}),
];

interface Run {
	readonly msgs: ReadonlyArray<ShellMsg>;
	readonly spawns: ReadonlyArray<{readonly programId: string; readonly parent: string | undefined}>;
}

const run = (
	intent: PickerIntent,
	options?: {
		readonly seed?: ReadonlyArray<readonly [string, string, string | undefined]>;
		readonly spawnFails?: string;
	},
): Effect.Effect<Run> =>
	Effect.scoped(
		Effect.gen(function* () {
			const harness = yield* pickerHarness(
				rows,
				options?.spawnFails === undefined ? undefined : {spawnFails: options.spawnFails},
			);
			for (const [id, program, parent] of options?.seed ?? []) {
				yield* harness.seed(id, program, parent);
			}
			const msgs = yield* runPickerIntent(intent, {shellProcessId}).pipe(
				Effect.provide(harness.layer),
			);
			return {
				msgs,
				spawns: harness.spawns().map((call) => ({programId: call.programId, parent: call.parent})),
			};
		}),
	);

describe("choosing a program", () => {
	it.effect("spawns exactly one process under the shell process and binds it to the window", () =>
		Effect.gen(function* () {
			const answer = yield* run(openProgram(window, programId("counter")));
			assert.deepStrictEqual(answer.spawns, [{programId: "counter", parent: shellProcessId}]);
			assert.deepStrictEqual(answer.msgs, [
				{type: "window.bind", windowId: window, processId: "process-1", takesKeys: false},
			]);
		}),
	);

	it.effect("refuses an unknown program in the window, and spawns nothing", () =>
		Effect.gen(function* () {
			const answer = yield* run(openProgram(window, programId("ghost")));
			assert.deepStrictEqual(answer.spawns, []);
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {cursor: 0, refusal: {_tag: "UnknownProgram", programId: "ghost"}},
				},
			]);
		}),
	);

	it.effect("refuses a headless program, which runs but can never fill a window", () =>
		Effect.gen(function* () {
			const answer = yield* run(openProgram(window, programId("indexer")));
			assert.deepStrictEqual(answer.spawns, []);
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {cursor: 0, refusal: {_tag: "ProgramHeadless", programId: "indexer"}},
				},
			]);
		}),
	);

	it.effect("turns a failed spawn into a refusal rather than a failure the caller must catch", () =>
		Effect.gen(function* () {
			const answer = yield* run(openProgram(window, programId("counter")), {
				spawnFails: "counter",
			});
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {
						cursor: 0,
						refusal: {
							_tag: "SpawnFailed",
							programId: "counter",
							reason: 'no live process has id "counter"',
						},
					},
				},
			]);
		}),
	);
});

describe("attaching to a running process", () => {
	it.effect("binds the window to a live process and spawns nothing", () =>
		Effect.gen(function* () {
			const answer = yield* run(attachProcess(window, processId("p-1")), {
				seed: [["p-1", "counter", undefined]],
			});
			assert.deepStrictEqual(answer.spawns, []);
			assert.deepStrictEqual(answer.msgs, [
				{type: "window.bind", windowId: window, processId: "p-1", takesKeys: false},
			]);
		}),
	);

	it.effect("refuses a process id that no longer resolves, as a value and never a throw", () =>
		Effect.gen(function* () {
			const answer = yield* run(attachProcess(window, processId("p-gone")));
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {cursor: 0, refusal: {_tag: "ProcessGone", processId: "p-gone"}},
				},
			]);
		}),
	);

	it.effect("refuses a live process whose program has no renderer to mount", () =>
		Effect.gen(function* () {
			const answer = yield* run(attachProcess(window, processId("p-9")), {
				seed: [["p-9", "indexer", undefined]],
			});
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {cursor: 0, refusal: {_tag: "ProgramHeadless", programId: "indexer"}},
				},
			]);
		}),
	);
});

describe("the picker row and the command line are one handler", () => {
	const entries: PickerEntries = {programs: programEntries(rows), processes: []};

	/**
	 * The intent a typed line ends in. The line reads to a core Msg (`../commands/line.ts`) and the
	 * core turns that Msg into the picker's own Cmd — `../commands/line.unit.test.ts` proves that
	 * link. Here the Cmd is rebuilt from the Msg so the two routes can be compared as values.
	 */
	const typedIntent = (line: string): PickerIntent | null => {
		const read = readCommandLine(line);
		if (read._tag !== "Msg") return null;
		if (read.msg.type === "window.open") {
			return openProgram(window, programId(read.msg.programId));
		}
		return read.msg.type === "window.attach"
			? attachProcess(window, processId(read.msg.processId))
			: null;
	};

	it.effect("`open counter` and choosing the counter row both produce one process", () =>
		Effect.gen(function* () {
			const chosen = pickerKey(window, entries, mountPicker(), "<enter>");
			const typed = typedIntent("open counter");
			assert.strictEqual(chosen._tag, "Chose");
			assert.isNotNull(typed);
			if (chosen._tag !== "Chose" || typed === null) return;

			assert.deepStrictEqual(chosen.intent, typed);
			const [fromRow, fromLine] = yield* Effect.all([run(chosen.intent), run(typed)], {
				concurrency: 2,
			});
			assert.deepStrictEqual(fromRow.spawns, [{programId: "counter", parent: shellProcessId}]);
			assert.deepStrictEqual(fromLine.spawns, fromRow.spawns);
			assert.deepStrictEqual(fromLine.msgs, fromRow.msgs);
		}),
	);

	it.effect("`attach <id>` and choosing the process row both bind without spawning", () =>
		Effect.gen(function* () {
			const withProcess: PickerEntries = {
				...noEntries,
				processes: [
					{
						_tag: "Process",
						processId: processId("p-1"),
						programId: programId("counter"),
						label: "Counter",
						parentId: null,
					},
				],
			};
			const chosen = pickerKey(window, withProcess, mountPicker(), "<enter>");
			const typed = typedIntent("attach p-1");
			assert.strictEqual(chosen._tag, "Chose");
			assert.isNotNull(typed);
			if (chosen._tag !== "Chose" || typed === null) return;

			assert.deepStrictEqual(chosen.intent, typed);
			const seed = [["p-1", "counter", undefined]] as const;
			const [fromRow, fromLine] = yield* Effect.all(
				[run(chosen.intent, {seed}), run(typed, {seed})],
				{concurrency: 2},
			);
			assert.deepStrictEqual(fromRow.spawns, []);
			assert.deepStrictEqual(fromLine.msgs, fromRow.msgs);
		}),
	);
});
