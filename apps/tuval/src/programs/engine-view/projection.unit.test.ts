import {Option} from "effect";
import {describe, expect, it} from "vitest";
import type {TableRow} from "../../table/row.ts";
import {processId, row, twoRootForest} from "./fixtures.ts";
import {type EngineGraph, engineEdgeId, projectProcessGraph} from "./projection.ts";

describe("projectProcessGraph", () => {
	it("emits one node per row, keyed by the process id and in input order", () => {
		const graph = projectProcessGraph(twoRootForest);
		expect(graph.nodes.map((node) => node.id)).toEqual(twoRootForest.map((r) => r.id));
		expect(graph.nodes[0]).toEqual({
			id: processId("root-a"),
			programId: "counter",
			ports: {},
			stateSummary: {lifecycle: "running", revision: 0},
		});
	});

	it("keeps node identity across calls, so a re-render moves nothing", () => {
		const first = projectProcessGraph(twoRootForest);
		const second = projectProcessGraph([...twoRootForest].reverse());
		expect([...first.nodes.map((node) => node.id)].sort()).toEqual(
			[...second.nodes.map((node) => node.id)].sort(),
		);
	});

	it("emits an edge exactly where the parent resolves to a row in the same input", () => {
		const graph = projectProcessGraph(twoRootForest);
		expect(graph.edges).toEqual([
			{id: engineEdgeId(processId("child-a1")), source: "root-a", target: "child-a1"},
			{id: engineEdgeId(processId("child-a2")), source: "root-a", target: "child-a2"},
			{
				id: engineEdgeId(processId("grandchild-a1")),
				source: "child-a1",
				target: "grandchild-a1",
			},
			{id: engineEdgeId(processId("child-b1")), source: "root-b", target: "child-b1"},
		]);
	});

	it("gives a row whose parent has left the table a node and no edge", () => {
		const rows = [row("orphan", "gone"), row("root-a", null)];
		const graph = projectProcessGraph(rows);
		expect(graph.nodes.map((node) => node.id)).toEqual([processId("orphan"), processId("root-a")]);
		expect(graph.edges).toEqual([]);
	});

	it("drops a self-parent and a two-row cycle rather than emitting either", () => {
		expect(projectProcessGraph([row("only", "only")]).edges).toEqual([]);
		const mutual = projectProcessGraph([row("a", "b"), row("b", "a")]);
		expect(mutual.nodes).toHaveLength(2);
		expect(mutual.edges).toEqual([{id: engineEdgeId(processId("a")), source: "b", target: "a"}]);
	});
});

// A seeded generator in this file rather than `fast-check`, the reason
// `src/commands/parse/property.unit.test.ts` states: the corpus is fixed, so a failure names one
// seed, and a package whose Effect pin already sits on its own catalog gains no dependency.
const seeded = (seed: number) => {
	let state = seed >>> 0;
	return (bound: number): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state % bound;
	};
};

const generate = (seed: number): ReadonlyArray<TableRow> => {
	const next = seeded(seed);
	const count = 1 + next(12);
	const ids = Array.from({length: count}, (_, index) => `p-${index}`);
	return ids.map((id) => {
		const draw = next(4);
		// A quarter root, a quarter pointing at a row that is not in the input, and half pointing at
		// some row of the input — which is where a self-parent and a cycle come from.
		if (draw === 0) return row(id, null);
		if (draw === 1) return row(id, `absent-${next(100)}`);
		return row(id, ids[next(count)] ?? id);
	});
};

const parentsOf = (graph: EngineGraph): ReadonlyMap<string, string> =>
	new Map(graph.edges.map((edge) => [edge.target as string, edge.source as string]));

const hasCycle = (graph: EngineGraph): boolean => {
	const parents = parentsOf(graph);
	for (const node of graph.nodes) {
		const seen = new Set<string>();
		let current: string | undefined = node.id;
		while (current !== undefined) {
			if (seen.has(current)) return true;
			seen.add(current);
			current = parents.get(current);
		}
	}
	return false;
};

describe("projectProcessGraph properties", () => {
	const seeds = Array.from({length: 200}, (_, index) => index + 1);

	it("holds one node per row, no dangling edge, no self-edge and no cycle over 200 seeds", () => {
		for (const seed of seeds) {
			const rows = generate(seed);
			const graph = projectProcessGraph(rows);
			const present = new Set(graph.nodes.map((node) => node.id as string));

			expect(graph.nodes, `seed ${seed}: one node per row`).toHaveLength(rows.length);
			for (const edge of graph.edges) {
				expect(present.has(edge.source), `seed ${seed}: dangling source ${edge.source}`).toBe(true);
				expect(present.has(edge.target), `seed ${seed}: dangling target ${edge.target}`).toBe(true);
				expect(edge.source, `seed ${seed}: self-edge`).not.toBe(edge.target);
			}
			expect(parentsOf(graph).size, `seed ${seed}: one parent per child`).toBe(graph.edges.length);
			expect(hasCycle(graph), `seed ${seed}: cycle`).toBe(false);
		}
	});

	it("is pure: the same rows twice yield a deeply equal graph and mutate no input", () => {
		for (const seed of seeds.slice(0, 50)) {
			const rows = generate(seed);
			const before = JSON.stringify(rows.map((r) => [r.id, Option.getOrNull(r.parentId)]));
			expect(projectProcessGraph(rows)).toEqual(projectProcessGraph(rows));
			expect(JSON.stringify(rows.map((r) => [r.id, Option.getOrNull(r.parentId)]))).toBe(before);
		}
	});
});
