import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	reconcileLineageEdges,
	reconcileSessionNodes,
	toLineageEdges,
	toSessionNodes,
} from "../../src/frontend-shell/canvas-adapter.js";
import type {LineageProjection} from "../../src/shared/lineage.js";

const node = (id: string, cwd = `/work/${id}`) => ({
	id: `pi:${id}` as LineageProjection["graph"]["nodes"][number]["id"],
	piSessionId: id,
	createdAt: 1,
	updatedAt: 2,
	cwd,
	sourceFiles: [`/fixtures/${id}.jsonl`],
});

const projection = (): LineageProjection => ({
	graph: {
		version: 2,
		nodes: [node("root"), node("spawned"), node("forked")],
		edges: [
			{
				id: "spawn:spawn-run",
				kind: "spawn",
				parent: node("root").id,
				child: node("spawned").id,
				runId: "spawn-run",
				observedAt: 10,
			},
			{
				id: `fork:${node("forked").id}`,
				kind: "fork",
				parent: node("root").id,
				child: node("forked").id,
				source: "protocol",
			},
		],
		continuity: [
			{
				id: "resume:resume-run",
				runId: "resume-run",
				session: node("spawned").id,
				parent: node("root").id,
				observedAt: 20,
			},
		],
		ownership: [],
	},
	problems: [],
});

describe("Tuval lineage canvas adapter", () => {
	it("keeps interaction fields while refreshing typed lineage node data", () => {
		const initial = toSessionNodes(projection()).find(
			(candidate) => candidate.id === node("root").id,
		);
		assert.ok(initial);
		const moved = {
			...initial,
			position: {x: 384, y: -96},
			selected: true,
			dragging: false,
			measured: {width: 248, height: 132},
		};
		const current = projection();
		const next: LineageProjection = {
			...current,
			graph: {
				...current.graph,
				nodes: current.graph.nodes.map((candidate) =>
					candidate.id === node("root").id ? node("root", "/work/renamed") : candidate,
				),
			},
		};
		const updated = reconcileSessionNodes([moved], next).find(
			(candidate) => candidate.id === node("root").id,
		);
		assert.ok(updated);
		assert.deepEqual(updated.position, moved.position);
		assert.equal(updated.selected, true);
		assert.deepEqual(updated.measured, moved.measured);
		assert.equal(updated.data.title, "renamed");
	});

	it("projects spawn and fork as distinct named edges without projecting resume as an edge", () => {
		const edges = toLineageEdges(projection());
		assert.deepEqual(
			edges.map((edge) => ({id: edge.id, kind: edge.data?.kind, label: edge.data?.label})),
			[
				{id: `fork:${node("forked").id}`, kind: "fork", label: "Dallanma"},
				{id: "spawn:spawn-run", kind: "spawn", label: "Oluşturma"},
			],
		);
		assert.equal(
			edges.some((edge) => edge.id.startsWith("resume:")),
			false,
		);
		assert.match(edges[0]?.ariaLabel ?? "", /dallanma ilişkisi/);
		assert.match(edges[1]?.ariaLabel ?? "", /oluşturma ilişkisi/);
	});

	it("keeps resume continuity on the stable session node", () => {
		const nodes = toSessionNodes(projection());
		const resumed = nodes.find((candidate) => candidate.id === node("spawned").id);
		assert.ok(resumed);
		assert.equal(resumed.data.continuity.length, 1);
		assert.match(resumed.ariaLabel ?? "", /1 devam kaydı/);
		assert.equal(nodes.filter((candidate) => candidate.id === node("spawned").id).length, 1);
	});

	it("keeps React Flow edge interaction fields while refreshing lineage data", () => {
		const [initial] = toLineageEdges(projection());
		assert.ok(initial);
		const selected = {...initial, selected: true, animated: true, zIndex: 7};
		const [updated] = reconcileLineageEdges([selected], projection());
		assert.ok(updated);
		assert.equal(updated.selected, true);
		assert.equal(updated.animated, true);
		assert.equal(updated.zIndex, 7);
		assert.equal(updated.data?.kind, "fork");
	});
});
