/**
 * What a choice does. The two routes into `runPickerIntent` — a highlighted picker row and a
 * resolved command line — are driven separately here and compared against one another, because
 * "the same handler" is the claim this slice exists to keep and nothing in the types enforces it.
 */

import {Effect, Result} from "effect";
import {describe, expect, it} from "vitest";
import type {AnyProgram} from "../../registry/program.ts";
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
import {attachProcess, openProgram, resolveCommandLine} from "./intent.ts";
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
): Promise<Run> =>
	Effect.runPromise(
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
					spawns: harness
						.spawns()
						.map((call) => ({programId: call.programId, parent: call.parent})),
				};
			}),
		),
	);

describe("choosing a program", () => {
	it("spawns exactly one process under the shell process and binds it to the window", async () => {
		const answer = await run(openProgram(window, programId("counter")));
		expect(answer.spawns).toEqual([{programId: "counter", parent: shellProcessId}]);
		expect(answer.msgs).toEqual([{type: "window.bind", windowId: window, processId: "process-1"}]);
	});

	it("refuses an unknown program in the window, and spawns nothing", async () => {
		const answer = await run(openProgram(window, programId("ghost")));
		expect(answer.spawns).toEqual([]);
		expect(answer.msgs).toEqual([
			{
				type: "window.setView",
				windowId: window,
				view: {cursor: 0, refusal: {_tag: "UnknownProgram", programId: "ghost"}},
			},
		]);
	});

	it("refuses a headless program, which runs but can never fill a window", async () => {
		const answer = await run(openProgram(window, programId("indexer")));
		expect(answer.spawns).toEqual([]);
		expect(answer.msgs).toEqual([
			{
				type: "window.setView",
				windowId: window,
				view: {cursor: 0, refusal: {_tag: "ProgramHeadless", programId: "indexer"}},
			},
		]);
	});

	it("turns a failed spawn into a refusal rather than a failure the caller must catch", async () => {
		const answer = await run(openProgram(window, programId("counter")), {spawnFails: "counter"});
		expect(answer.msgs).toEqual([
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
	});
});

describe("attaching to a running process", () => {
	it("binds the window to a live process and spawns nothing", async () => {
		const answer = await run(attachProcess(window, processId("p-1")), {
			seed: [["p-1", "counter", undefined]],
		});
		expect(answer.spawns).toEqual([]);
		expect(answer.msgs).toEqual([{type: "window.bind", windowId: window, processId: "p-1"}]);
	});

	it("refuses a process id that no longer resolves, as a value and never a throw", async () => {
		const answer = await run(attachProcess(window, processId("p-gone")));
		expect(answer.msgs).toEqual([
			{
				type: "window.setView",
				windowId: window,
				view: {cursor: 0, refusal: {_tag: "ProcessGone", processId: "p-gone"}},
			},
		]);
	});

	it("refuses a live process whose program has no renderer to mount", async () => {
		const answer = await run(attachProcess(window, processId("p-9")), {
			seed: [["p-9", "indexer", undefined]],
		});
		expect(answer.msgs).toEqual([
			{
				type: "window.setView",
				windowId: window,
				view: {cursor: 0, refusal: {_tag: "ProgramHeadless", programId: "indexer"}},
			},
		]);
	});
});

describe("the picker row and the command line are one handler", () => {
	const entries: PickerEntries = {programs: programEntries(rows), processes: []};

	it("`window:open counter` and choosing the counter row both produce one process", async () => {
		const chosen = pickerKey(window, entries, mountPicker(), "<enter>");
		const typed = resolveCommandLine(window, "open counter");
		expect(chosen._tag).toBe("Chose");
		expect(Result.isSuccess(typed)).toBe(true);
		if (chosen._tag !== "Chose" || !Result.isSuccess(typed)) return;

		expect(chosen.intent).toEqual(typed.success);
		const [fromRow, fromLine] = await Promise.all([run(chosen.intent), run(typed.success)]);
		expect(fromRow.spawns).toEqual([{programId: "counter", parent: shellProcessId}]);
		expect(fromLine.spawns).toEqual(fromRow.spawns);
		expect(fromLine.msgs).toEqual(fromRow.msgs);
	});

	it("`window:attach <id>` and choosing the process row both bind without spawning", async () => {
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
		const typed = resolveCommandLine(window, "attach p-1");
		expect(chosen._tag).toBe("Chose");
		expect(Result.isSuccess(typed)).toBe(true);
		if (chosen._tag !== "Chose" || !Result.isSuccess(typed)) return;

		expect(chosen.intent).toEqual(typed.success);
		const seed = [["p-1", "counter", undefined]] as const;
		const [fromRow, fromLine] = await Promise.all([
			run(chosen.intent, {seed}),
			run(typed.success, {seed}),
		]);
		expect(fromRow.spawns).toEqual([]);
		expect(fromLine.msgs).toEqual(fromRow.msgs);
	});
});
