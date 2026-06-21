import {assert, describe, it} from "@effect/vitest";
import {findCycles} from "./graph.ts";
import type {DependencyEdge} from "./Ledger.ts";

describe("findCycles", () => {
	it("a DAG has no cycles", () => {
		const edges: DependencyEdge[] = [
			{child: 102, requires: 101},
			{child: 103, requires: 101},
			{child: 103, requires: 102},
		];
		assert.deepStrictEqual(findCycles(edges), []);
	});

	it("detects a two-node cycle, reported as an ascending-sorted set", () => {
		const edges: DependencyEdge[] = [
			{child: 102, requires: 101},
			{child: 101, requires: 102},
		];
		assert.deepStrictEqual(findCycles(edges), [[101, 102]]);
	});

	it("detects a three-node cycle", () => {
		const edges: DependencyEdge[] = [
			{child: 101, requires: 102},
			{child: 102, requires: 103},
			{child: 103, requires: 101},
		];
		assert.deepStrictEqual(findCycles(edges), [[101, 102, 103]]);
	});

	it("is order-independent: permuting edge insertion order yields the same cycle set", () => {
		const a: DependencyEdge[] = [
			{child: 101, requires: 102},
			{child: 102, requires: 103},
			{child: 103, requires: 101},
		];
		const b: DependencyEdge[] = [
			{child: 103, requires: 101},
			{child: 101, requires: 102},
			{child: 102, requires: 103},
		];
		assert.deepStrictEqual(findCycles(a), findCycles(b));
	});

	it("reports two disjoint cycles, each sorted, the list sorted by smallest member", () => {
		const edges: DependencyEdge[] = [
			{child: 201, requires: 202},
			{child: 202, requires: 201},
			{child: 101, requires: 102},
			{child: 102, requires: 101},
		];
		assert.deepStrictEqual(findCycles(edges), [
			[101, 102],
			[201, 202],
		]);
	});

	it("a self-loop edge is a degenerate cycle of one node", () => {
		assert.deepStrictEqual(findCycles([{child: 101, requires: 101}]), [[101]]);
	});
});
