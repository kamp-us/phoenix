import {describe, expect, it} from "vitest";
import type {ItemFieldValue, ProjectItem} from "../io/projects.ts";
import {betCellsOf, betRowsOf} from "./bet-rows.ts";
import {graphOf, type IssueNode} from "./group.ts";

const option = (
	fieldName: string,
	name: string,
	creator: string | null = "founder",
): ItemFieldValue => ({
	fieldId: `F_${fieldName}`,
	fieldName,
	value: {_tag: "Option", optionId: `O_${name}`, name},
	creator,
	updatedAt: "2026-09-26T00:00:00Z",
});

const item = (
	number: number,
	values: ReadonlyArray<ItemFieldValue>,
	over: Partial<ProjectItem> = {},
): ProjectItem => ({
	itemId: `I_${number}`,
	contentNumber: number,
	contentType: "Issue",
	repository: "o/r",
	values,
	...over,
});

const node = (number: number, over: Partial<IssueNode> = {}): IssueNode => ({
	number,
	open: true,
	parent: null,
	subIssues: [],
	blockedBy: [],
	...over,
});

describe("betCellsOf", () => {
	it("keeps this repo's issue rows whose Stage is `bet`, with the Stage setter and the Size", () => {
		const cells = betCellsOf(
			[
				item(1, [option("Stage", "bet", "agent"), option("Size", "M", "someone-else")]),
				item(2, [option("Stage", "proposed")]),
				item(3, [option("Stage", "bet")], {repository: "o/other"}),
				item(4, [option("Stage", "bet")], {contentType: "PullRequest"}),
				item(5, [option("Stage", "bet", null)]),
			],
			"o/r",
		);
		expect(cells).toEqual([
			{head: 1, size: "M", setter: "agent"},
			{head: 5, size: null, setter: null},
		]);
	});
});

describe("betRowsOf", () => {
	it("derives each row's group through the membership module", () => {
		const graph = graphOf([
			node(10, {subIssues: [11, 12]}),
			node(11),
			node(12, {open: false}),
			node(20, {blockedBy: [21]}),
			node(21, {blockedBy: [22]}),
			node(22),
			node(30),
		]);
		const rows = betRowsOf(
			[
				{head: 10, size: "L", setter: "founder"},
				{head: 20, size: "M", setter: "founder"},
				{head: 30, size: "S", setter: "founder"},
			],
			graph,
		);
		expect(rows).toEqual({
			_tag: "Derived",
			rows: [
				{head: 10, size: "L", setter: "founder", kind: "epic", covers: [10, 11]},
				{head: 20, size: "M", setter: "founder", kind: "chain", covers: [20, 21, 22]},
				{head: 30, size: "S", setter: "founder", kind: null, covers: [30]},
			],
		});
	});

	it("names the nodes it still needs rather than guessing a group", () => {
		const rows = betRowsOf(
			[{head: 20, size: "M", setter: "founder"}],
			graphOf([node(20, {blockedBy: [21]})]),
		);
		expect(rows).toEqual({_tag: "Incomplete", missing: [21]});
	});
});
