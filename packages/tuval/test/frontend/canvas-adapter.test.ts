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

	it("routes coincident spawn and fork relations on distinct visible lanes", () => {
		const current = projection();
		const coincident: LineageProjection = {
			...current,
			graph: {
				...current.graph,
				edges: [
					current.graph.edges[0]!,
					{
						...current.graph.edges[1]!,
						parent: node("root").id,
						child: node("spawned").id,
					},
				],
			},
		};
		const edges = toLineageEdges(coincident);
		assert.deepEqual(
			edges.map((edge) => edge.data?.laneOffset),
			[-16, 16],
		);
	});

	it("keeps every dense depth in one deterministic column without card overlap", () => {
		const root = node("dense-root");
		const children = Array.from({length: 12}, (_, index) => node(`dense-child-${index + 1}`));
		const dense: LineageProjection = {
			graph: {
				version: 2,
				nodes: [root, ...children],
				edges: children.map((child, index) => ({
					id: `spawn:dense-${index + 1}`,
					kind: "spawn" as const,
					parent: root.id,
					child: child.id,
					runId: `dense-${index + 1}`,
					observedAt: index + 1,
				})),
				continuity: [],
				ownership: [],
			},
			problems: [],
		};
		const nodes = toSessionNodes(dense);
		const childNodes = nodes.filter((candidate) => candidate.id !== root.id);
		assert.equal(new Set(childNodes.map((candidate) => candidate.position.x)).size, 1);
		const sorted = [...childNodes].sort((left, right) => left.position.y - right.position.y);
		for (let index = 1; index < sorted.length; index += 1) {
			const previous = sorted[index - 1]!;
			const currentNode = sorted[index]!;
			assert.ok(currentNode.position.y - previous.position.y >= 160);
		}
	});

	it("assigns skip-layer relations to deterministic obstacle-free routing gutters", () => {
		const first = node("first");
		const middle = node("middle");
		const last = node("last");
		const skipLayer: LineageProjection = {
			graph: {
				version: 2,
				nodes: [first, middle, last],
				edges: [
					{
						id: "spawn:first-middle",
						kind: "spawn",
						parent: first.id,
						child: middle.id,
						runId: "first-middle",
						observedAt: 1,
					},
					{
						id: "spawn:first-last",
						kind: "spawn",
						parent: first.id,
						child: last.id,
						runId: "first-last",
						observedAt: 2,
					},
					{
						id: `fork:${last.id}`,
						kind: "fork",
						parent: middle.id,
						child: last.id,
						source: "protocol",
					},
				],
				continuity: [],
				ownership: [],
			},
			problems: [],
		};
		const nodes = toSessionNodes(skipLayer);
		assert.deepEqual(
			nodes.map(({id, position}) => ({id, position})),
			[
				{id: first.id, position: {x: 0, y: 0}},
				{id: last.id, position: {x: 720, y: 0}},
				{id: middle.id, position: {x: 360, y: 0}},
			],
		);
		const skipped = toLineageEdges(skipLayer).find((edge) => edge.id === "spawn:first-last");
		assert.equal(skipped?.data?.routeY, -32);
		assert.equal(
			toLineageEdges(skipLayer).find((edge) => edge.id === "spawn:first-middle")?.data?.routeY,
			null,
		);
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
