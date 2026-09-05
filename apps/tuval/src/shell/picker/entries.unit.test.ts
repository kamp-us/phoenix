import {assert, describe, expect, it} from "@effect/vitest";
import {Effect, Option} from "effect";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {TableRow} from "../../table/row.ts";
import {flatten, processEntries, programEntries, readEntries} from "./entries.ts";
import {pickerHarness, programRow} from "./fixtures.ts";

describe("picker entries", () => {
	it("lists every registry row that can fill a window, by id and label", () => {
		const entries = programEntries([
			programRow("counter", {label: "Counter"}),
			programRow("pi"),
			programRow("indexer", {renderer: false}),
		]);
		expect(entries).toEqual([
			{_tag: "Program", programId: "counter", label: "Counter"},
			// No `label` on the row: the picker falls back to `identity.program`, never to nothing.
			{_tag: "Program", programId: "pi", label: "pi"},
		]);
	});

	it("lists running processes with their program and parent, and skips headless ones", () => {
		const rows = [
			programRow("counter", {label: "Counter"}),
			programRow("indexer", {renderer: false}),
		];
		const table: ReadonlyArray<TableRow> = [
			{
				id: ProcessId.make("p-1"),
				programId: ProgramId.make("counter"),
				parentId: Option.none(),
				ports: {},
				stateSummary: {lifecycle: "running", revision: 0},
			},
			{
				id: ProcessId.make("p-2"),
				programId: ProgramId.make("counter"),
				parentId: Option.some(ProcessId.make("p-1")),
				ports: {},
				stateSummary: {lifecycle: "running", revision: 3},
			},
			{
				id: ProcessId.make("p-3"),
				programId: ProgramId.make("indexer"),
				parentId: Option.none(),
				ports: {},
				stateSummary: {lifecycle: "running", revision: 0},
			},
		];
		expect(processEntries(rows, table)).toEqual([
			{_tag: "Process", processId: "p-1", programId: "counter", label: "Counter", parentId: null},
			{_tag: "Process", processId: "p-2", programId: "counter", label: "Counter", parentId: "p-1"},
		]);
	});

	it.effect("reads both lists off the live registry and process table", () =>
		Effect.gen(function* () {
			const answer = yield* Effect.scoped(
				Effect.gen(function* () {
					const harness = yield* pickerHarness([
						programRow("counter", {label: "Counter"}),
						programRow("indexer", {renderer: false}),
					]);
					yield* harness.seed("p-1", "counter");
					yield* harness.seed("p-9", "indexer");
					return yield* readEntries.pipe(Effect.provide(harness.layer));
				}),
			);
			assert.deepStrictEqual(
				answer.programs.map((entry) => entry.programId),
				[ProgramId.make("counter")],
			);
			assert.deepStrictEqual(
				answer.processes.map((entry) => entry.processId),
				["p-1"],
			);
			assert.lengthOf(flatten(answer), 2);
		}),
	);
});
