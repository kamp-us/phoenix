/**
 * Which open issues the on-call board holds, and the writes that place them with their target.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_ON_CALL} from "../config/keys/boards.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {ItemFieldValue} from "../io/projects.ts";
import {dueChecks} from "./check.ts";
import type {HeadRow} from "./flags.ts";
import {onCallIssuesOf, onCallItemsOf, originsFor, planOnCall} from "./on-call-prep.ts";
import type {Row} from "./sync.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");

const issue = (number: number, over: Partial<ListedIssue> = {}): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels: [],
	author: "someone",
	association: "MEMBER",
	...over,
});

const option = (fieldName: string, name: string, updatedAt = "2026-09-26T00:00:00.000Z") =>
	({
		fieldId: `F_${fieldName}`,
		fieldName,
		value: {_tag: "Option", optionId: `${fieldName}:${name}`, name},
		creator: "owner",
		updatedAt,
	}) satisfies ItemFieldValue;

const row = (number: number, values: ReadonlyArray<ItemFieldValue>): Row => ({
	itemId: `PVTI_${number}`,
	issue: number,
	values,
});

const byNumber = (issues: ReadonlyArray<ListedIssue>) =>
	new Map(issues.map((one) => [one.number, one] as const));

describe("originsFor", () => {
	it("reads the table row's Origin and adds customer for someone who only uses the product", () => {
		const outside = issue(1, {association: "NONE", author: "a-user"});
		expect(originsFor(outside, row(1, [option("Origin", "driver pick")]))).toEqual([
			"driver pick",
			"customer",
		]);
		expect(originsFor(outside, undefined)).toEqual(["customer"]);
		expect(originsFor(issue(2), row(2, [option("Origin", "bet")]))).toEqual(["bet"]);
		expect(originsFor(issue(2), undefined)).toEqual([]);
	});
});

describe("onCallIssuesOf", () => {
	it("holds every open issue the rule routes there, in arrival order", () => {
		const open = byNumber([
			issue(9, {labels: ["type:bug"]}),
			issue(4, {association: "NONE", author: "a-user"}),
			issue(5, {labels: ["type:feature"]}),
		]);

		expect(
			onCallIssuesOf(open, new Map(), [], SHIPPED_ON_CALL, []).map((one) => one.number),
		).toEqual([4, 9]);
	});

	it("routes a customer's report by the default route even after a lane wrote its Origin", () => {
		const open = byNumber([issue(4, {association: "NONE", author: "a-user"})]);
		const table = new Map([[4, row(4, [option("Origin", "driver pick")])]]);

		expect(onCallIssuesOf(open, table, [], SHIPPED_ON_CALL, []).map((one) => one.number)).toEqual([
			4,
		]);
	});

	it("leaves an issue the table answered on the table, whatever the rule says", () => {
		const open = byNumber([issue(1, {labels: ["type:bug"]}), issue(2, {labels: ["type:bug"]})]);
		const table = new Map([
			[1, row(1, [option("Stage", "bet")])],
			[2, row(2, [option("Stage", "in lane")])],
		]);

		expect(onCallIssuesOf(open, table, [], SHIPPED_ON_CALL, []).map((one) => one.number)).toEqual([
			2,
		]);
	});

	it("leaves the members of a bet group on the table with their head", () => {
		const open = byNumber([
			issue(1),
			issue(2, {labels: ["type:bug"]}),
			issue(3, {labels: ["type:bug"]}),
		]);
		const heads = [
			{
				group: {_tag: "Chain", head: 1, members: [2]} as const,
				stage: {name: "bet", setter: "owner", setAt: "2026-09-20T00:00:00.000Z"},
			},
		];

		expect(
			onCallIssuesOf(open, new Map(), heads, SHIPPED_ON_CALL, []).map((one) => one.number),
		).toEqual([3]);
	});

	it("leaves a shipped bet due its check on the table, so it lands on one board", () => {
		const open = byNumber([issue(1, {labels: ["type:bug"]}), issue(2, {labels: ["type:bug"]})]);
		const shipped = (head: number, setAt: string): HeadRow => ({
			group: {_tag: "Single", head},
			stage: {name: "shipped", setter: "owner", setAt},
			size: "S",
			children: 0,
			memberStages: [],
			origin: "bet",
		});
		const heads = [shipped(1, "2026-09-01T00:00:00.000Z"), shipped(2, "2026-09-25T00:00:00.000Z")];
		const due = dueChecks(heads, 14, NOW);

		expect(due.map((check) => check.group.head)).toEqual([1]);
		expect(
			onCallIssuesOf(open, new Map(), heads, SHIPPED_ON_CALL, due).map((one) => one.number),
		).toEqual([2]);
	});
});

const FIELDS = {
	responseTarget: {
		id: "F_target",
		options: new Map([
			["same day", "T_same"],
			["this week", "T_week"],
		]),
	},
	plainWords: "F_plain",
};

describe("planOnCall", () => {
	it("adds an issue with no item, then sets its target once and its plain words", () => {
		const bug = issue(3, {labels: ["type:bug", "p0"], title: "Login fails"});
		const first = planOnCall({
			fields: FIELDS,
			settings: SHIPPED_ON_CALL,
			rows: new Map(),
			issues: [bug],
		});
		expect(first).toEqual([{_tag: "Add", issue: 3}]);

		const added = planOnCall({
			fields: FIELDS,
			settings: SHIPPED_ON_CALL,
			rows: new Map([[3, row(3, [])]]),
			issues: [bug],
		});
		expect(added.map((write) => (write._tag === "Set" ? [write.field, write.shown] : []))).toEqual([
			["Response target", "same day"],
			["In plain words", '"Login fails"'],
		]);
	});

	it("never moves a target already set, so the wait stays timed from arrival", () => {
		const bug = issue(3, {labels: ["p0"], title: "Login fails"});
		const standing = row(3, [
			option("Response target", "this week"),
			{
				fieldId: "F_plain",
				fieldName: "In plain words",
				value: {_tag: "Text", text: "Login fails"},
				creator: "owner",
				updatedAt: "2026-09-26T00:00:00.000Z",
			},
		]);

		expect(
			planOnCall({
				fields: FIELDS,
				settings: SHIPPED_ON_CALL,
				rows: new Map([[3, standing]]),
				issues: [bug],
			}),
		).toEqual([]);
	});
});

describe("onCallItemsOf", () => {
	it("reads each open item's target and arrival, and times a target set now from now", () => {
		const rows = new Map([
			[1, row(1, [option("Response target", "this week", "2026-09-20T00:00:00.000Z")])],
			[2, row(2, [])],
			[3, row(3, [option("Response target", "same day")])],
		]);
		const open = byNumber([issue(1), issue(2, {labels: ["p0"]}), issue(4)]);

		expect(
			onCallItemsOf(rows, open, [issue(2, {labels: ["p0"]}), issue(4)], SHIPPED_ON_CALL, NOW),
		).toEqual([
			{issue: 1, target: {name: "this week", since: "2026-09-20T00:00:00.000Z"}},
			{issue: 2, target: {name: "same day", since: NOW.toISOString()}},
			{issue: 4, target: {name: "this week", since: NOW.toISOString()}},
		]);
	});
});
