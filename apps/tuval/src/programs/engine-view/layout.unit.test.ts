import {describe, expect, it} from "vitest";
import {row, twoRootForest, widePortForest} from "./fixtures.ts";
import {type LaidOutNode, layoutEngineGraph, measureNode} from "./layout.ts";
import {projectProcessGraph} from "./projection.ts";

const laidOut = (rows = twoRootForest) => layoutEngineGraph(projectProcessGraph(rows));

const overlaps = (left: LaidOutNode, right: LaidOutNode): boolean =>
	left.position.x < right.position.x + right.size.width &&
	right.position.x < left.position.x + left.size.width &&
	left.position.y < right.position.y + right.size.height &&
	right.position.y < left.position.y + left.size.height;

const overlappingPairs = (nodes: ReadonlyArray<LaidOutNode>): ReadonlyArray<string> =>
	nodes.flatMap((left, index) =>
		nodes
			.slice(index + 1)
			.filter((right) => overlaps(left, right))
			.map((right) => `${left.id} × ${right.id}`),
	);

const rankOf = (nodes: ReadonlyArray<LaidOutNode>, id: string): number => {
	const node = nodes.find((candidate) => candidate.id === id);
	if (node === undefined) throw new Error(`no node ${id}`);
	return node.position.y;
};

describe("layoutEngineGraph", () => {
	it("places a two-root forest top-down, a child always below its parent", () => {
		const {nodes} = laidOut();
		expect(nodes).toHaveLength(twoRootForest.length);
		expect(rankOf(nodes, "root-a")).toBeLessThan(rankOf(nodes, "child-a1"));
		expect(rankOf(nodes, "child-a1")).toBeLessThan(rankOf(nodes, "grandchild-a1"));
		expect(rankOf(nodes, "root-b")).toBeLessThan(rankOf(nodes, "child-b1"));
		// Both roots share the top rank, so neither component is drawn as a child of the other.
		expect(rankOf(nodes, "root-a")).toBe(rankOf(nodes, "root-b"));
	});

	it("overlaps no two node boxes, including across the two roots", () => {
		expect(overlappingPairs(laidOut().nodes)).toEqual([]);
	});

	it("carries the projection's edges through untouched", () => {
		const graph = projectProcessGraph(twoRootForest);
		expect(layoutEngineGraph(graph).edges).toEqual(graph.edges);
	});

	it("is deterministic: the same input twice yields identical positions", () => {
		expect(JSON.stringify(laidOut().nodes)).toBe(JSON.stringify(laidOut().nodes));
	});

	it("lays a row order out the same way, so a re-render does not move a node", () => {
		const forward = laidOut(twoRootForest);
		const reversed = laidOut([...twoRootForest].reverse());
		const positionsOf = (nodes: ReadonlyArray<LaidOutNode>) =>
			Object.fromEntries(nodes.map((node) => [node.id, node.position]));
		expect(positionsOf(reversed.nodes)).toEqual(positionsOf(forward.nodes));
	});

	it("sizes a node from its own content rather than a constant", () => {
		const bare = measureNode(projectProcessGraph([row("root-a", null)]).nodes[0]!);
		const [, wide] = projectProcessGraph(widePortForest).nodes;
		const wideSize = measureNode(wide!);
		expect(wideSize.width).toBeGreaterThan(bare.width);
		expect(wideSize.height).toBeGreaterThan(bare.height);
	});

	it("lays a wide port list out without overlap", () => {
		expect(overlappingPairs(laidOut(widePortForest).nodes)).toEqual([]);
	});

	it("positions a box by its top-left corner, never its centre", () => {
		const [first] = laidOut([row("root-a", null)]).nodes;
		// A single node is centred at (width/2, height/2) by dagre with a zero margin, so a
		// top-left conversion puts it at the origin and an unconverted centre would not.
		expect(first?.position).toEqual({x: 0, y: 0});
	});
});
