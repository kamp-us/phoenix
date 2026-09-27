import {assert, describe, expect, it} from "@effect/vitest";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Effect, Option, Result} from "effect";
import {OpenProjects, projectLabels} from "../../projects/open-projects.ts";
import type {TableRow} from "../../table/row.ts";
import {shellId, shellProgram, unwiredShellEffects} from "../program.ts";
import {flatten, groupKeyOf, processEntries, programEntries, readEntries} from "./entries.ts";
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
				title: Option.none(),
				status: Option.none(),
			},
			{
				id: ProcessId.make("p-2"),
				programId: ProgramId.make("counter"),
				parentId: Option.some(ProcessId.make("p-1")),
				ports: {},
				stateSummary: {lifecycle: "running", revision: 3},
				title: Option.none(),
				status: Option.none(),
			},
			{
				id: ProcessId.make("p-3"),
				programId: ProgramId.make("indexer"),
				parentId: Option.none(),
				ports: {},
				stateSummary: {lifecycle: "running", revision: 0},
				title: Option.none(),
				status: Option.none(),
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

	it.effect("offers neither the shell's own row nor its running process (#7946)", () =>
		Effect.gen(function* () {
			const shell = shellProgram({effects: unwiredShellEffects});
			const answer = yield* Effect.scoped(
				Effect.gen(function* () {
					const harness = yield* pickerHarness([shell, programRow("counter")]);
					yield* harness.seed("shell-process", shellId);
					yield* harness.seed("p-1", "counter");
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
		}),
	);
});

describe("session entries, generated from the open-projects record (#9694)", () => {
	const claude = programRow("claude-session", {label: "Claude", folderAtStart: true});
	const pi = programRow("pi-session", {label: "Pi", folderAtStart: true});
	const counter = programRow("counter", {label: "Counter"});
	const rows = [claude, counter, pi];

	/** The labels the record's open projects carry, made the way the kernel makes them. */
	const labelsAfterOpening = (...folders: ReadonlyArray<string>) => {
		let record = OpenProjects.none;
		for (const folder of folders) {
			const opened = record.open(folder);
			if (Result.isFailure(opened)) throw new Error(`could not open ${folder}`);
			record = opened.success.projects;
		}
		return projectLabels(record.projects);
	};

	it("offers each session row once per open project, labelled with the project", () => {
		const projects = labelsAfterOpening("/code/kamp-us/phoenix", "/code/kamp-us/demlik");
		const phoenix = projects[0];
		const demlik = projects[1];
		if (phoenix === undefined || demlik === undefined) throw new Error("two projects are open");
		expect(programEntries(rows, projects)).toEqual([
			{
				_tag: "Program",
				programId: "claude-session",
				label: "Claude · phoenix",
				place: {_tag: "Project", key: phoenix.key, label: "phoenix"},
			},
			{
				_tag: "Program",
				programId: "pi-session",
				label: "Pi · phoenix",
				place: {_tag: "Project", key: phoenix.key, label: "phoenix"},
			},
			{
				_tag: "Program",
				programId: "claude-session",
				label: "Claude · demlik",
				place: {_tag: "Project", key: demlik.key, label: "demlik"},
			},
			{
				_tag: "Program",
				programId: "pi-session",
				label: "Pi · demlik",
				place: {_tag: "Project", key: demlik.key, label: "demlik"},
			},
			// A row that keeps its own folder is offered once, after the sessions.
			{_tag: "Program", programId: "counter", label: "Counter"},
		]);
	});

	it("offers each session row once for home when no project is open", () => {
		expect(programEntries(rows, labelsAfterOpening())).toEqual([
			{_tag: "Program", programId: "claude-session", label: "Claude · home", place: {_tag: "Home"}},
			{_tag: "Program", programId: "pi-session", label: "Pi · home", place: {_tag: "Home"}},
			{_tag: "Program", programId: "counter", label: "Counter"},
		]);
	});

	it("tells two same-named projects apart the way their tiles do", () => {
		const labels = programEntries(
			[claude],
			labelsAfterOpening("/code/kamp-us/phoenix", "/code/usirin/phoenix"),
		).map((entry) => entry.label);
		expect(labels).toEqual(["Claude · kamp-us/phoenix", "Claude · usirin/phoenix"]);
	});

	it("scales to four harnesses in ten projects: forty session entries, grouped by project", () => {
		const harnesses = ["Claude", "Pi", "agy", "codex"].map((label) =>
			programRow(`${label}-session`, {label, folderAtStart: true}),
		);
		const folders = Array.from({length: 10}, (_, index) => `/code/project-${index}`);
		const entries = programEntries(harnesses, labelsAfterOpening(...folders));
		expect(entries).toHaveLength(40);
		// Each project's four sit together, in the order the projects opened.
		expect(entries.slice(0, 4).map((entry) => entry.label)).toEqual([
			"Claude · project-0",
			"Pi · project-0",
			"agy · project-0",
			"codex · project-0",
		]);
		expect(new Set(entries.map(groupKeyOf)).size).toBe(10);
	});
});
