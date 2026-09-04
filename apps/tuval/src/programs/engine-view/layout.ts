/**
 * Top-down placement of the projected graph through `@dagrejs/dagre`.
 *
 * Founder ruling 3 on #7500 is to take a layout library rather than re-derive the frozen POC's
 * `nodeDepths` depth/lane placement (`packages/tuval/src/frontend-shell/canvas-adapter.ts` on
 * `epic/7140`). React Flow's own layouting guide picks the library: "If you need to organize your
 * flows into a tree, we highly recommend dagre", and of the alternative it says "We don't often
 * recommend elkjs because it's complexity makes it difficult for us to support folks"
 * (https://reactflow.dev/learn/layouting/layouting).
 *
 * Two things this module owes that dagre does not give for free. Dagre returns a node's **centre**,
 * while every canvas downstream places a box by its top-left corner, so the centre is converted
 * here rather than in each renderer. And dagre's result depends on the order nodes and edges were
 * inserted, so both are inserted in id order: the same set of processes then lays out identically
 * however the snapshot happened to order its rows, which is what keeps a re-render from moving a
 * node the user is looking at.
 */

import {Graph, layout} from "@dagrejs/dagre";
import type {PortDeclaration} from "../../table/row.ts";
import type {EngineEdge, EngineGraph, EngineNode} from "./projection.ts";

export interface NodeSize {
	readonly width: number;
	readonly height: number;
}

export interface NodePosition {
	readonly x: number;
	readonly y: number;
}

/** A node with the box the layout gave it, positioned by its top-left corner. */
export interface LaidOutNode extends EngineNode {
	readonly size: NodeSize;
	readonly position: NodePosition;
}

export interface LaidOutGraph {
	readonly nodes: ReadonlyArray<LaidOutNode>;
	readonly edges: ReadonlyArray<EngineEdge>;
}

export interface LayoutOptions {
	/** Gap between two nodes on one rank. */
	readonly nodeSeparation?: number;
	/** Gap between two ranks. */
	readonly rankSeparation?: number;
}

const DEFAULT_NODE_SEPARATION = 48;
const DEFAULT_RANK_SEPARATION = 72;

// A node is measured from its text rather than rendered and read back, because the layout runs
// before anything mounts and must agree with itself in a test with no DOM. The constants are the
// monospace cell the canvas renders in; a renderer that changes them passes its own here.
const CHARACTER_WIDTH = 8;
const LINE_HEIGHT = 20;
const HORIZONTAL_PADDING = 24;
const VERTICAL_PADDING = 16;
const MINIMUM_WIDTH = 160;

const portLine = (name: string, port: PortDeclaration): string =>
	`${name} ${port.kind} ${port.direction}`;

/** Every line the generic node renders, longest of which sets its width. */
const contentLines = (node: EngineNode): ReadonlyArray<string> => [
	node.id,
	node.programId,
	`${node.stateSummary.lifecycle} r${node.stateSummary.revision}`,
	...Object.entries(node.ports).map(([name, port]) => portLine(name, port)),
];

/** The box a node needs for its own content: a process with eight ports is taller than a bare one. */
export const measureNode = (node: EngineNode): NodeSize => {
	const lines = contentLines(node);
	const widest = lines.reduce((width, line) => Math.max(width, line.length), 0);
	return {
		width: Math.max(MINIMUM_WIDTH, widest * CHARACTER_WIDTH + HORIZONTAL_PADDING),
		height: lines.length * LINE_HEIGHT + VERTICAL_PADDING,
	};
};

const byId = (left: {readonly id: string}, right: {readonly id: string}): number =>
	left.id === right.id ? 0 : left.id < right.id ? -1 : 1;

/**
 * Places the graph top-down and returns it unchanged apart from the added boxes. Several roots are
 * the normal case — a process table is a forest, not a tree — and dagre packs each component
 * without overlapping the others, so no synthetic root is introduced.
 */
export const layoutEngineGraph = (
	graph: EngineGraph,
	options: LayoutOptions = {},
): LaidOutGraph => {
	const sizes = new Map(graph.nodes.map((node) => [node.id as string, measureNode(node)]));
	const dagreGraph = new Graph({directed: true, multigraph: false, compound: false});
	dagreGraph.setGraph({
		rankdir: "TB",
		nodesep: options.nodeSeparation ?? DEFAULT_NODE_SEPARATION,
		ranksep: options.rankSeparation ?? DEFAULT_RANK_SEPARATION,
		marginx: 0,
		marginy: 0,
	});
	dagreGraph.setDefaultEdgeLabel(() => ({}));
	for (const [id, size] of [...sizes].sort(([left], [right]) => (left < right ? -1 : 1))) {
		dagreGraph.setNode(id, {width: size.width, height: size.height});
	}
	for (const edge of [...graph.edges].sort(byId)) {
		dagreGraph.setEdge(edge.source, edge.target);
	}
	layout(dagreGraph);
	const nodes = graph.nodes.map((node): LaidOutNode => {
		const size = sizes.get(node.id) ?? {width: MINIMUM_WIDTH, height: LINE_HEIGHT};
		const placed = dagreGraph.node(node.id);
		const centreX = typeof placed?.x === "number" ? placed.x : 0;
		const centreY = typeof placed?.y === "number" ? placed.y : 0;
		return {
			...node,
			size,
			position: {
				x: Math.round(centreX - size.width / 2),
				y: Math.round(centreY - size.height / 2),
			},
		};
	});
	return {nodes, edges: graph.edges};
};
