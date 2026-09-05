import {Option} from "effect";
import {describe, expect, it} from "vitest";
import {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";
import {projectProcessGraph} from "./projection.ts";
import {tableRowsFromSnapshot} from "./snapshot-rows.ts";

const wireRow = (id: string, parentId: string | null): ProcessRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make("counter"),
	parentId: parentId === null ? null : ProcessId.make(parentId),
	ports: {increment: {kind: "count", direction: "in"}},
	stateSummary: {lifecycle: "running", revision: 3},
	recency: 2,
});

describe("tableRowsFromSnapshot", () => {
	it("turns the wire's null parent into a None and an id into a Some", () => {
		const [root, child] = tableRowsFromSnapshot([wireRow("p-1", null), wireRow("p-2", "p-1")]);
		expect(Option.isNone(root!.parentId)).toBe(true);
		expect(Option.getOrNull(child!.parentId)).toBe("p-1");
		expect(root!.stateSummary).toEqual({lifecycle: "running", revision: 3});
	});

	it("drops `recency`, which is desk state the graph has no use for", () => {
		const [row] = tableRowsFromSnapshot([wireRow("p-1", null)]);
		expect(row).not.toHaveProperty("recency");
	});

	it("feeds the projection straight from a snapshot's rows", () => {
		const graph = projectProcessGraph(
			tableRowsFromSnapshot([wireRow("p-1", null), wireRow("p-2", "p-1")]),
		);
		expect(graph.nodes.map((node) => node.id)).toEqual(["p-1", "p-2"]);
		expect(graph.edges).toEqual([{id: "edge:p-2", source: "p-1", target: "p-2"}]);
	});
});
