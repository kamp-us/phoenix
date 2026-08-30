import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	SESSION_WORKING_SET_MAX_NODES,
	SESSION_WORKING_SET_PAGE_SIZE,
	selectSessionWorkingSet,
} from "../../src/frontend-shell/session-working-set.js";
import type {LineageProjection} from "../../src/shared/lineage.js";

const node = (index: number, cwd = `/archive/project-${index}`) => ({
	id: `pi:session-${index}` as LineageProjection["graph"]["nodes"][number]["id"],
	piSessionId: `session-${index}`,
	createdAt: index,
	updatedAt: index,
	cwd,
	sourceFiles: [`/archive/session-${index}.jsonl`],
});

const corpus = (): LineageProjection => {
	const nodes = Array.from({length: 1_205}, (_, index) => node(index));
	return {
		graph: {
			version: 2,
			nodes,
			edges: [
				{
					id: "spawn:old-child",
					kind: "spawn",
					parent: node(2).id,
					child: node(3).id,
					runId: "old-child",
					observedAt: 4,
				},
				{
					id: `fork:${node(4).id}`,
					kind: "fork",
					parent: node(3).id,
					child: node(4).id,
					source: "protocol",
				},
			],
			continuity: [
				{
					id: "resume:old-child",
					runId: "old-child",
					session: node(3).id,
					parent: node(2).id,
					observedAt: 5,
				},
			],
			ownership: [],
		},
		problems: [],
	};
};

describe("Tuval session working set", () => {
	it("bounds a 1,000-plus archive while retaining a selected session and its lineage", () => {
		const result = selectSessionWorkingSet(corpus(), {pinnedIds: [node(3).id]});
		const ids = new Set(result.projection.graph.nodes.map(({id}) => id));

		assert.equal(result.totalCount, 1_205);
		assert.equal(result.matchedCount, 1_205);
		assert.ok(result.visibleCount <= SESSION_WORKING_SET_MAX_NODES);
		assert.equal(result.hiddenCount, result.totalCount - result.visibleCount);
		assert.ok(ids.has(node(3).id));
		assert.ok(ids.has(node(2).id));
		assert.ok(ids.has(node(4).id));
		assert.ok(ids.has(node(1_204).id));
		assert.deepEqual(
			result.projection.graph.edges.map(({id}) => id),
			["spawn:old-child", `fork:${node(4).id}`],
		);
		assert.equal(result.projection.graph.continuity.length, 1);
	});

	it("never advances past a page member when pinned lineage fills the remaining cap", () => {
		const base = corpus();
		const pinned = node(600);
		const related = Array.from({length: 8}, (_, index) => node(500 + index));
		const projection: LineageProjection = {
			...base,
			graph: {
				...base.graph,
				edges: [
					...base.graph.edges,
					...related.map((child, index) => ({
						id: `spawn:pinned-${index}`,
						kind: "spawn" as const,
						parent: pinned.id,
						child: child.id,
						runId: `pinned-${index}`,
						observedAt: index,
					})),
				],
			},
		};
		const result = selectSessionWorkingSet(projection, {pinnedIds: [pinned.id]});
		const ids = new Set(result.projection.graph.nodes.map(({id}) => id));

		for (const recent of [node(1_204), node(1_203), node(1_202)]) {
			assert.ok(ids.has(recent.id));
		}
		assert.ok(ids.has(pinned.id));
		assert.equal(result.pageEnd, SESSION_WORKING_SET_PAGE_SIZE);
		assert.ok(result.visibleCount <= SESSION_WORKING_SET_MAX_NODES);
	});

	it("searches the complete archive without mounting unrelated matches", () => {
		const result = selectSessionWorkingSet(corpus(), {query: "project-17"});
		const ids = result.projection.graph.nodes.map(({id}) => id);

		assert.equal(result.matchedCount, 11);
		assert.equal(result.pageStart, 1);
		assert.equal(result.pageEnd, SESSION_WORKING_SET_PAGE_SIZE);
		assert.equal(result.hasOlder, true);
		assert.ok(ids.includes(node(179).id));
		assert.ok(ids.every((id) => id.includes("17")));
		assert.ok(result.visibleCount <= SESSION_WORKING_SET_PAGE_SIZE);
	});

	it("pages progressively through older sessions with honest ranges", () => {
		const recent = selectSessionWorkingSet(corpus());
		const older = selectSessionWorkingSet(corpus(), {page: 1});
		const recentIds = new Set(recent.projection.graph.nodes.map(({id}) => id));
		const olderIds = new Set(older.projection.graph.nodes.map(({id}) => id));

		assert.equal(recent.pageStart, 1);
		assert.equal(recent.pageEnd, SESSION_WORKING_SET_PAGE_SIZE);
		assert.equal(recent.hasNewer, false);
		assert.equal(recent.hasOlder, true);
		assert.equal(older.pageStart, SESSION_WORKING_SET_PAGE_SIZE + 1);
		assert.equal(older.pageEnd, SESSION_WORKING_SET_PAGE_SIZE * 2);
		assert.equal(older.hasNewer, true);
		assert.equal(older.hasOlder, true);
		assert.equal(
			[...olderIds].some((id) => recentIds.has(id)),
			false,
		);
	});

	it("filters roots and lineage sessions before pagination", () => {
		const roots = selectSessionWorkingSet(corpus(), {filter: "roots", query: "session-3"});
		const lineage = selectSessionWorkingSet(corpus(), {filter: "lineage"});

		assert.equal(roots.matchedCount, 110);
		assert.equal(
			roots.projection.graph.nodes.some(({id}) => id === node(3).id),
			false,
		);
		assert.deepEqual(
			new Set(lineage.projection.graph.nodes.map(({id}) => id)),
			new Set([node(2).id, node(3).id, node(4).id]),
		);
		assert.equal(lineage.matchedCount, 3);
	});
});
