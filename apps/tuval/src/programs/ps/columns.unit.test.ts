import {describe, expect, it} from "vitest";
import {tableRowsFromSnapshot} from "../engine-view/snapshot-rows.ts";
import {NO_PARENT, portSummary, psColumnOrder, psColumns} from "./columns.ts";
import {row} from "./fixtures.ts";

const only = (wire: ReturnType<typeof row>) => {
	const [converted] = tableRowsFromSnapshot([wire]);
	if (converted === undefined) throw new Error("fixture produced no row");
	return converted;
};

describe("ps columns", () => {
	it("is the six the process table shows, in the order it shows them", () => {
		expect(psColumnOrder).toEqual([
			"process",
			"program",
			"parent",
			"ports",
			"lifecycle",
			"revision",
		]);
		expect(psColumns.map((column) => column.header)).toEqual([
			"Process",
			"Program",
			"Parent",
			"Ports",
			"Lifecycle",
			"Revision",
		]);
	});

	it("renders a row's six cells off the row and nothing else", () => {
		const cells = psColumns.map((column) =>
			column.cell(
				only(
					row("child-a1", {
						parent: "root-a",
						program: "shell",
						revision: 12,
						lifecycle: "stopping",
						ports: {
							transcript: {kind: "tuval/transcript", direction: "out"},
							prompt: {kind: "tuval/prompt", direction: "in"},
							cancel: {kind: "tuval/prompt", direction: "in"},
						},
					}),
				),
			),
		);
		expect(cells).toEqual([
			"child-a1",
			"shell",
			"root-a",
			"3 (tuval/prompt, tuval/transcript)",
			"stopping",
			"12",
		]);
	});

	it("shows a root's absent parent as the empty-cell dash", () => {
		expect(psColumns[2]?.cell(only(row("root-a")))).toBe(NO_PARENT);
	});
});

describe("portSummary", () => {
	it("is the bare count when a process declares no ports", () => {
		expect(portSummary({})).toBe("0");
	});

	it("counts every port and names each distinct kind once, in a stable order", () => {
		expect(
			portSummary({
				b: {kind: "tuval/prompt", direction: "in"},
				a: {kind: "tuval/transcript", direction: "out"},
				c: {kind: "tuval/prompt", direction: "in"},
			}),
		).toBe("3 (tuval/prompt, tuval/transcript)");
	});
});
