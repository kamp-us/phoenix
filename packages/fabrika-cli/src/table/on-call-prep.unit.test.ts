/**
 * Which open issues the on-call board holds, and the writes that place them with their target.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_ON_CALL} from "../config/keys/boards.ts";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {ItemFieldValue} from "../io/projects.ts";
import {candidatesOf} from "./agenda.ts";
import {dueChecks} from "./check.ts";
import type {HeadRow} from "./flags.ts";
import {onCallIssuesOf, onCallItemsOf, originsFor, planOnCall} from "./on-call-prep.ts";
import type {Row} from "./sync.ts";
import {parseTableDay, type TableDay} from "./table-day.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");

const issue = (number: number, over: Partial<ListedIssue> = {}): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels: [],
	author: "someone",
	association: "MEMBER",
	createdAt: "2026-09-01T00:00:00Z",
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

const CUSTOMER = {association: "NONE", author: "a-user"} as const;

describe("onCallIssuesOf", () => {
	it("holds every open issue the rule routes there, in arrival order", () => {
		const open = byNumber([
			issue(9, {labels: ["type:bug", "p1"]}),
			issue(4, {...CUSTOMER, labels: ["type:bug", "p2"]}),
			issue(5, {labels: ["type:feature", "p0"]}),
		]);

		expect(
			onCallIssuesOf(open, new Map(), [], SHIPPED_ON_CALL, []).map((one) => one.number),
		).toEqual([4, 9]);
	});

	it("routes p0 and p1 bugs and customer bugs, never p2 bugs, other types or untyped issues", () => {
		const open = byNumber([
			issue(1, {labels: ["type:bug", "p0"]}),
			issue(2, {labels: ["type:bug", "p1"], author: "agent[bot]", association: "NONE"}),
			issue(3, {...CUSTOMER, labels: ["type:bug", "p2"]}),
			issue(4, {...CUSTOMER, labels: ["type:bug"]}),
			issue(5, {labels: ["type:bug", "p2"]}),
			issue(6, {labels: ["type:bug"]}),
			issue(7, {...CUSTOMER, labels: ["type:feature", "p0"]}),
			issue(8, {...CUSTOMER, labels: []}),
			issue(10, {...CUSTOMER, labels: ["status:needs-triage", "p0"]}),
			issue(11, {labels: ["p0"]}),
		]);

		expect(
			onCallIssuesOf(open, new Map(), [], SHIPPED_ON_CALL, []).map((one) => one.number),
		).toEqual([1, 2, 3, 4]);
	});

	it("plans no add and no Response target for a p2 bug the rule leaves on the table", () => {
		const routed = onCallIssuesOf(
			byNumber([issue(5, {labels: ["type:bug", "p2"]})]),
			new Map(),
			[],
			SHIPPED_ON_CALL,
			[],
		);

		expect(routed).toEqual([]);
		expect(
			planOnCall({fields: FIELDS, settings: SHIPPED_ON_CALL, rows: new Map(), issues: routed}),
		).toEqual([]);
	});

	it("hands a customer's ask back to the table, where the agenda proposes it under Customers", () => {
		const open = byNumber([
			issue(7, {...CUSTOMER, labels: ["type:feature", "status:triaged"]}),
			issue(3, {...CUSTOMER, labels: ["type:bug", "status:triaged"]}),
		]);
		const onCall = new Set(
			onCallIssuesOf(open, new Map(), [], SHIPPED_ON_CALL, []).map((one) => one.number),
		);

		expect([...onCall]).toEqual([3]);
		const {candidates} = candidatesOf({
			settings: SHIPPED_TABLE,
			open,
			rows: new Map(),
			followUps: [],
			flagged: new Map(),
			ruled: [],
			target: parseTableDay("2026-10-03") as TableDay,
			onCall,
		});
		expect(candidates.map((one) => `${one.section} #${one.issue}`)).toEqual(["Customers #7"]);
	});

	it("routes by the rule a repository declares, the old any-one rule included", () => {
		const settings = {...SHIPPED_ON_CALL, route: [{origins: ["customer"]}, {types: ["bug"]}]};
		const open = byNumber([
			issue(5, {labels: ["type:bug", "p2"]}),
			issue(7, {...CUSTOMER, labels: ["type:feature"]}),
			issue(8, {labels: ["type:feature"]}),
		]);

		expect(onCallIssuesOf(open, new Map(), [], settings, []).map((one) => one.number)).toEqual([
			5, 7,
		]);
	});

	it("routes a customer's report by the default route even after a lane wrote its Origin", () => {
		const open = byNumber([issue(4, {...CUSTOMER, labels: ["type:bug"]})]);
		const table = new Map([[4, row(4, [option("Origin", "driver pick")])]]);

		expect(onCallIssuesOf(open, table, [], SHIPPED_ON_CALL, []).map((one) => one.number)).toEqual([
			4,
		]);
	});

	it("leaves an issue the table answered on the table, whatever the rule says", () => {
		const bug = (number: number) => issue(number, {labels: ["type:bug", "p1"]});
		const open = byNumber([bug(1), bug(2), bug(3), bug(4)]);
		const table = new Map([
			[1, row(1, [option("Stage", "bet")])],
			[2, row(2, [option("Stage", "in lane")])],
			[3, row(3, [option("Stage", "not now")])],
			[4, row(4, [option("Stage", "check")])],
		]);

		expect(onCallIssuesOf(open, table, [], SHIPPED_ON_CALL, []).map((one) => one.number)).toEqual([
			2,
		]);
	});

	it("leaves the members of a bet group on the table with their head", () => {
		const open = byNumber([
			issue(1),
			issue(2, {labels: ["type:bug", "p1"]}),
			issue(3, {labels: ["type:bug", "p1"]}),
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
		const open = byNumber([
			issue(1, {labels: ["type:bug", "p1"]}),
			issue(2, {labels: ["type:bug", "p1"]}),
		]);
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

describe("planOnCall", () => {
	it("adds an issue with no item, then sets its target and its plain words", () => {
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

	it("moves the target to the one a relabel picks, and plans nothing once it reads so", () => {
		const bug = issue(3, {labels: ["p0"], title: "Login fails"});
		const standing = (target: string) =>
			row(3, [
				option("Response target", target),
				{
					fieldId: "F_plain",
					fieldName: "In plain words",
					value: {_tag: "Text", text: "Login fails"},
					creator: "owner",
					updatedAt: "2026-09-26T00:00:00.000Z",
				},
			]);
		const plan = (target: string) =>
			planOnCall({
				fields: FIELDS,
				settings: SHIPPED_ON_CALL,
				rows: new Map([[3, standing(target)]]),
				issues: [bug],
			});

		expect(plan("this week").map((write) => (write._tag === "Set" ? write.shown : null))).toEqual([
			"same day",
		]);
		expect(plan("same day")).toEqual([]);
	});
});

describe("onCallItemsOf", () => {
	it("reads each open item and each routed issue off the issue, never off its cell", () => {
		const rows = new Map([
			[1, row(1, [option("Response target", "same day", "2026-09-20T00:00:00.000Z")])],
			[2, row(2, [])],
			[3, row(3, [option("Response target", "same day")])],
		]);
		const filed = "2026-09-10T00:00:00Z";
		const open = byNumber([issue(1, {createdAt: filed}), issue(2, {labels: ["p0"]}), issue(4)]);

		expect(onCallItemsOf(rows, open, [issue(4)])).toEqual([
			{issue: 1, labels: [], createdAt: filed},
			{issue: 2, labels: ["p0"], createdAt: "2026-09-01T00:00:00Z"},
			{issue: 4, labels: [], createdAt: "2026-09-01T00:00:00Z"},
		]);
	});
});
