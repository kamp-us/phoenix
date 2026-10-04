/** Group rows: an epic's and a chain's members, derived from the native graph alone. */
import {describe, expect, it} from "vitest";
import {type Bets, graphOf, groupOf, type IssueNode, issuesOf, kindOf} from "./group.ts";

const node = (number: number, over: Partial<IssueNode> = {}): IssueNode => ({
	number,
	open: true,
	parent: null,
	subIssues: [],
	blockedBy: [],
	...over,
});

const NONE: Bets = new Set();

describe("an epic row", () => {
	it("stands for its open sub-issues and nothing else", () => {
		const graph = graphOf([
			node(10, {subIssues: [11, 12, 13]}),
			node(11, {parent: 10}),
			node(12, {parent: 10, blockedBy: [99]}),
			node(13, {parent: 10}),
		]);

		expect(groupOf(10, graph, NONE)).toEqual({
			_tag: "Derived",
			group: {_tag: "Epic", head: 10, members: [11, 12, 13]},
		});
	});

	it("drops a member once it closes", () => {
		const graph = graphOf([
			node(10, {subIssues: [11, 12]}),
			node(11, {parent: 10}),
			node(12, {parent: 10, open: false}),
		]);

		const membership = groupOf(10, graph, NONE);

		expect(membership._tag === "Derived" && issuesOf(membership.group)).toEqual([10, 11]);
		expect(membership._tag === "Derived" && kindOf(membership.group)).toBe("epic");
	});

	it("is still the epic's row once every sub-issue has closed", () => {
		const graph = graphOf([node(10, {subIssues: [11]}), node(11, {open: false})]);

		expect(groupOf(10, graph, NONE)).toEqual({
			_tag: "Derived",
			group: {_tag: "Epic", head: 10, members: []},
		});
	});
});

describe("a chain row", () => {
	it("stands for its open blockers, followed transitively", () => {
		const graph = graphOf([
			node(1, {blockedBy: [2]}),
			node(2, {blockedBy: [3, 4]}),
			node(3),
			node(4, {blockedBy: [5]}),
			node(5),
		]);

		expect(groupOf(1, graph, NONE)).toEqual({
			_tag: "Derived",
			group: {_tag: "Chain", head: 1, members: [2, 3, 4, 5]},
		});
	});

	it("stops at a closed blocker, which blocks nothing any more", () => {
		const graph = graphOf([
			node(1, {blockedBy: [2, 6]}),
			node(2, {open: false, blockedBy: [3]}),
			node(3),
			node(6),
		]);

		expect(groupOf(1, graph, NONE)).toEqual({
			_tag: "Derived",
			group: {_tag: "Chain", head: 1, members: [6]},
		});
	});

	it("counts a blocker two chains share as a member of both", () => {
		const graph = graphOf([node(1, {blockedBy: [3]}), node(2, {blockedBy: [3]}), node(3)]);

		for (const head of [1, 2]) {
			const membership = groupOf(head, graph, NONE);
			expect(membership._tag === "Derived" && issuesOf(membership.group)).toEqual([head, 3]);
		}
	});

	it("survives a blocking cycle without counting the head as its own member", () => {
		const graph = graphOf([node(1, {blockedBy: [2]}), node(2, {blockedBy: [1]})]);

		expect(groupOf(1, graph, NONE)).toEqual({
			_tag: "Derived",
			group: {_tag: "Chain", head: 1, members: [2]},
		});
	});

	it("is a single row when nothing open blocks it", () => {
		const graph = graphOf([node(1, {blockedBy: [2]}), node(2, {open: false})]);

		expect(groupOf(1, graph, NONE)).toEqual({_tag: "Derived", group: {_tag: "Single", head: 1}});
	});
});

describe("a bet row", () => {
	it("ends the chain that reaches it, so the row it blocks stands for neither it nor its blockers", () => {
		const graph = graphOf([node(1, {blockedBy: [2]}), node(2, {blockedBy: [3]}), node(3)]);

		expect(groupOf(1, graph, new Set([2]))).toEqual({
			_tag: "Derived",
			group: {_tag: "Single", head: 1},
		});
	});

	it("still heads its own chain", () => {
		const graph = graphOf([node(1, {blockedBy: [2]}), node(2, {blockedBy: [3]}), node(3)]);

		expect(groupOf(2, graph, new Set([2]))).toEqual({
			_tag: "Derived",
			group: {_tag: "Chain", head: 2, members: [3]},
		});
	});

	it("leaves a blocker in the chain when a path with no bet on it reaches the head", () => {
		const graph = graphOf([
			node(1, {blockedBy: [2, 3]}),
			node(2, {blockedBy: [3, 4]}),
			node(3),
			node(4),
		]);

		expect(groupOf(1, graph, new Set([2]))).toEqual({
			_tag: "Derived",
			group: {_tag: "Chain", head: 1, members: [3]},
		});
	});

	it("is left out of the epic row it hangs under", () => {
		const graph = graphOf([
			node(10, {subIssues: [11, 12]}),
			node(11, {parent: 10}),
			node(12, {parent: 10}),
		]);

		expect(groupOf(10, graph, new Set([12]))).toEqual({
			_tag: "Derived",
			group: {_tag: "Epic", head: 10, members: [11]},
		});
	});
});

describe("an unread graph", () => {
	it("names every node it still needs rather than guessing membership", () => {
		const graph = graphOf([node(1, {blockedBy: [2, 3]}), node(2, {blockedBy: [4]})]);

		expect(groupOf(1, graph, NONE)).toEqual({_tag: "Incomplete", missing: [3, 4]});
		expect(groupOf(7, graph, NONE)).toEqual({_tag: "Incomplete", missing: [7]});
	});
});
