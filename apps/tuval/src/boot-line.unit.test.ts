import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Option} from "effect";
import {describe, expect, it} from "vitest";
import {renderRow} from "./boot-line.ts";
import {ProjectLabels} from "./projects/labels.ts";
import type {TableRow} from "./table/row.ts";

const KEY = "-Users-ada-code-github.com-kamp_-us-phoenix";

const row = (id: string, programId: string, parent?: string): TableRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(programId),
	parentId: parent === undefined ? Option.none() : Option.some(ProcessId.make(parent)),
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
	title: Option.none(),
	status: Option.none(),
});

describe("renderRow", () => {
	const projects = ProjectLabels.of([{key: KEY, label: "phoenix"}]);

	it("prints a project process's ids under its label, never the path key", () => {
		const line = renderRow(row(`${KEY}/counter`, `${KEY}/counter`, `${KEY}/log`), projects);
		expect(line).toBe(
			"tuval: process phoenix/counter program=phoenix/counter parent=phoenix/log ports=- state=running@1",
		);
		expect(line).not.toContain(KEY);
	});

	it("prints a global process's ids unchanged", () => {
		expect(renderRow(row("p-1", "module-counter"), projects)).toBe(
			"tuval: process p-1 program=module-counter parent=- ports=- state=running@1",
		);
	});
});
