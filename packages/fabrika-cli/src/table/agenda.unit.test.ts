/**
 * The agenda core on its own: who counts as a customer, the order candidates come in, how a chain
 * absorbs a row it covers, the size a group adds up to, and the pick a ruling row asks for.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_APPETITE_SIZES} from "../config/keys/appetite-sizes.ts";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {ItemFieldValue} from "../io/projects.ts";
import {
	admit,
	type Candidate,
	candidatesOf,
	closedProposals,
	EMPTY_SELECTION,
	isCustomer,
	optionsOf,
	type PrepInput,
	pickRec,
	planPrep,
	prepPlan,
	sizeOfGroup,
} from "./agenda.ts";
import type {Group} from "./group.ts";
import type {Row} from "./sync.ts";
import {parseTableDay, type TableDay} from "./table-day.ts";

const NEXT = parseTableDay("2026-10-03") as TableDay;

const issue = (number: number, over: Partial<ListedIssue> = {}): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels: ["status:triaged"],
	author: "worker",
	association: "MEMBER",
	...over,
});

const stageRow = (number: number, stage: string): Row => ({
	itemId: `PVTI_${number}`,
	issue: number,
	values: [
		{
			fieldId: "F_stage",
			fieldName: "Stage",
			value: {_tag: "Option", optionId: `stage:${stage}`, name: stage},
			creator: "owner",
			updatedAt: "2026-09-20T00:00:00.000Z",
		} satisfies ItemFieldValue,
	],
});

const single = (head: number): Group => ({_tag: "Single", head});
const chain = (head: number, ...members: [number, ...number[]]): Group => ({
	_tag: "Chain",
	head,
	members,
});
const candidate = (number: number, section = "Customers"): Candidate => ({
	issue: number,
	section,
	reason: {_tag: "Customer"},
});

describe("isCustomer", () => {
	it("is someone outside the repository, never a worker, a bot or an unread association", () => {
		expect(isCustomer(issue(1, {association: "NONE", author: "user"}))).toBe(true);
		expect(isCustomer(issue(1, {association: "CONTRIBUTOR", author: "user"}))).toBe(true);
		expect(isCustomer(issue(1, {association: "COLLABORATOR", author: "user"}))).toBe(false);
		expect(isCustomer(issue(1, {association: "NONE", author: "renovate[bot]"}))).toBe(false);
		expect(isCustomer(issue(1, {association: "", author: "user"}))).toBe(false);
	});
});

describe("candidatesOf", () => {
	const input = (open: ReadonlyArray<ListedIssue>, rows: ReadonlyArray<Row> = []) => ({
		settings: SHIPPED_TABLE,
		open: new Map(open.map((one) => [one.number, one] as const)),
		rows: new Map(rows.map((row) => [row.issue, row] as const)),
		followUps: [],
		flagged: new Map(),
		target: NEXT,
		onCall: new Set<number>(),
	});

	it("sorts a section p0 first, and never re-proposes an answered row", () => {
		const customer = (number: number, labels: ReadonlyArray<string>) =>
			issue(number, {association: "NONE", author: "user", labels: ["status:triaged", ...labels]});
		const {candidates} = candidatesOf(
			input(
				[customer(5, ["p2"]), customer(3, []), customer(9, ["p0"]), customer(7, ["p0"])],
				[stageRow(7, "not now")],
			),
		);

		expect(candidates.map((one) => one.issue)).toEqual([9, 5, 3]);
	});

	it("follows the configured section order", () => {
		const settings = {
			...SHIPPED_TABLE,
			sections: ["New bets", "Customers", "Tails", "Outside the bets"],
		};
		const pitch =
			"## Pitch\n**Problem:** p\n**Arc:** a\n**Appetite:** S\n**Rabbit-holes:** r\n**No-gos:** n";
		const {candidates} = candidatesOf({
			...input([
				issue(1, {association: "NONE", author: "user"}),
				issue(2, {labels: ["type:epic", "status:triaged"], body: pitch}),
			]),
			settings,
		});

		expect(candidates.map((one) => `${one.section} #${one.issue}`)).toEqual([
			"New bets #2",
			"Customers #1",
		]);
	});

	it("never proposes an issue the on-call board holds, nor lists it for triage", () => {
		const customer = (number: number, labels: ReadonlyArray<string>) =>
			issue(number, {association: "NONE", author: "user", labels});
		const {candidates, triageFirst} = candidatesOf({
			...input([customer(3, ["status:triaged"]), customer(4, ["status:triaged"]), customer(5, [])]),
			onCall: new Set([3, 5]),
		});

		expect(candidates.map((one) => one.issue)).toEqual([4]);
		expect(triageFirst).toEqual([]);
	});

	it("drops a standing agenda row once the on-call board holds its issue", () => {
		const cell = (fieldName: string, value: ItemFieldValue["value"]): ItemFieldValue => ({
			fieldId: `F_${fieldName}`,
			fieldName,
			value,
			creator: "owner",
			updatedAt: "2026-09-20T00:00:00.000Z",
		});
		const standing = (number: number): Row => ({
			itemId: `PVTI_${number}`,
			issue: number,
			values: [
				cell("Section", {_tag: "Option", optionId: "s:Customers", name: "Customers"}),
				cell("Table day", {_tag: "Date", date: NEXT}),
				cell("Rec", {_tag: "Text", text: "yes."}),
			],
		});
		const {candidates} = candidatesOf({
			...input([issue(3), issue(4)], [standing(3), standing(4)]),
			onCall: new Set([3]),
		});

		expect(candidates.map((one) => `${one.reason._tag} #${one.issue}`)).toEqual(["Standing #4"]);
	});
});

describe("admit", () => {
	it("skips a candidate a chosen row covers, and moves a chosen row inside a chain that covers it", () => {
		let selection = admit(EMPTY_SELECTION, candidate(2), single(2), 5);
		selection = admit(selection, candidate(1), chain(1, 2, 3), 5);
		selection = admit(selection, candidate(3), single(3), 5);

		expect(selection.chosen.map((one) => one.candidate.issue)).toEqual([1]);
	});

	it("counts a chain once and leaves a candidate out once the cap is full", () => {
		let selection = admit(EMPTY_SELECTION, candidate(1), chain(1, 2, 3), 2);
		selection = admit(selection, candidate(4), single(4), 2);
		selection = admit(selection, candidate(5), single(5), 2);

		expect(selection.chosen.map((one) => one.candidate.issue)).toEqual([1, 4]);
		expect(selection.overflow).toEqual([5]);
	});
});

describe("sizeOfGroup", () => {
	const open = new Map([
		[1, issue(1)],
		[2, issue(2)],
		[3, issue(3)],
	]);

	it("sizes a row by what its issues add up to, and an epic row as L", () => {
		expect(sizeOfGroup(single(1), open, SHIPPED_APPETITE_SIZES)).toEqual({size: "S", usd: 15});
		expect(sizeOfGroup(chain(1, 2), open, SHIPPED_APPETITE_SIZES)).toEqual({size: "M", usd: 30});
		expect(sizeOfGroup(chain(1, 2, 3), open, SHIPPED_APPETITE_SIZES)).toEqual({size: "L", usd: 45});
		expect(
			sizeOfGroup({_tag: "Epic", head: 1, members: []}, open, SHIPPED_APPETITE_SIZES).size,
		).toBe("L");
	});
});

describe("optionsOf and pickRec", () => {
	it("reads the list under an Options heading, each cut to its first sentence", () => {
		expect(
			optionsOf("intro\n\n## Options\n\n1. **Keep it.** Works.\n2. Drop it\n\n## Next\n- no"),
		).toEqual(["Keep it", "Drop it"]);
	});

	it("reads Option lines when there is no heading", () => {
		expect(optionsOf("- **Option A:** ship now. More.\n- Option B — wait a week")).toEqual([
			"ship now",
			"wait a week",
		]);
	});

	it("asks for a pick even when no option reads, and names a member it asks about", () => {
		expect(pickRec(issue(4, {body: "no list"}), 4)).toMatch(/^needs your pick: .*open it/);
		expect(pickRec(issue(4, {body: "## Options\n- A\n- B"}), 1)).toBe(
			"needs your pick on #4: A, or B.",
		);
	});
});

describe("closedProposals", () => {
	it("names every proposed row whose issue is not open, and no other", () => {
		const rows = new Map([
			[1, stageRow(1, "proposed")],
			[2, stageRow(2, "proposed")],
			[3, stageRow(3, "bet")],
		]);

		expect(closedProposals(rows, new Set([2]))).toEqual([1]);
	});
});

const select = (name: string, options: ReadonlyArray<string>) => ({
	id: `F_${name}`,
	options: new Map(options.map((option) => [option, `${name}:${option}`] as const)),
});
const FIELDS = {
	stage: select("Stage", ["proposed", "check"]),
	section: select("Section", SHIPPED_TABLE.sections),
	size: select("Size", ["S", "M", "L"]),
	rec: "F_rec",
	plainWords: "F_plain",
	tableDay: "F_day",
};
const input = (over: Partial<PrepInput>): PrepInput => ({
	fields: FIELDS,
	target: NEXT,
	rows: new Map(),
	open: new Set(),
	agenda: [],
	rollover: [],
	removals: [],
	checks: [],
	onCall: new Set(),
	...over,
});
const cells = {size: "S" as const, rec: "yes.", plainWords: "Issue 1"};

describe("planPrep with an on-call board", () => {
	const plan = (over: Partial<PrepInput>) => planPrep(input(over));

	it("takes a routed issue's table row off, so it is on the on-call board only", () => {
		const writes = plan({
			rows: new Map([[4, stageRow(4, "proposed")]]),
			open: new Set([4]),
			onCall: new Set([4]),
		});

		expect(writes).toEqual([{_tag: "Delete", issue: 4, itemId: "PVTI_4"}]);
	});

	it("never adds a routed chain member to the table", () => {
		const writes = plan({
			open: new Set([1, 2, 3]),
			agenda: [{issue: 1, section: "Tails", group: chain(1, 2, 3), flaggedBet: false, cells}],
			onCall: new Set([2]),
		});

		expect(writes.flatMap((write) => (write._tag === "Add" ? [write.issue] : []))).toEqual([1, 3]);
	});

	it("keeps a carried bet or a check on the table even when the rule routes its issue", () => {
		const writes = plan({
			rows: new Map([
				[5, stageRow(5, "bet")],
				[6, stageRow(6, "shipped")],
			]),
			open: new Set([5, 6]),
			rollover: [5],
			checks: [{issue: 6, section: "Tails", rec: "check it.", plainWords: "Issue 6"}],
			onCall: new Set([5, 6]),
		});

		expect(writes.some((write) => write._tag === "Delete")).toBe(false);
	});
});

describe("prepPlan writes Rec only into an empty cell", () => {
	const withRec = (row: Row, text: string): Row => ({
		...row,
		values: [
			...row.values,
			{
				fieldId: "F_rec",
				fieldName: "Rec",
				value: {_tag: "Text", text},
				creator: "owner",
				updatedAt: "2026-09-20T00:00:00.000Z",
			},
		],
	});
	const recWrites = (plan: ReturnType<typeof prepPlan>) =>
		plan.writes.filter(
			(write) => write._tag !== "Add" && write._tag !== "Delete" && write.field === "Rec",
		);

	it("leaves a carried bet's Rec a person wrote, and names it", () => {
		const plan = prepPlan(
			input({
				rows: new Map([[5, withRec(stageRow(5, "bet"), "needs your ruling: both fixes conflict")]]),
				open: new Set([5]),
				rollover: [5],
			}),
		);

		expect(recWrites(plan)).toEqual([]);
		expect(plan.kept).toEqual([
			{issue: 5, rec: "needs your ruling: both fixes conflict", wanted: null},
		]);
	});

	it("never replaces an agenda row's different Rec, and names it beside prep's text", () => {
		const plan = prepPlan(
			input({
				rows: new Map([[1, withRec(stageRow(1, "proposed"), "no: wait for the audit.")]]),
				open: new Set([1]),
				agenda: [{issue: 1, section: "Tails", group: single(1), flaggedBet: false, cells}],
			}),
		);

		expect(recWrites(plan)).toEqual([]);
		expect(plan.kept).toEqual([{issue: 1, rec: "no: wait for the audit.", wanted: "yes."}]);
	});

	it("never replaces a check row's different Rec", () => {
		const plan = prepPlan(
			input({
				rows: new Map([[6, withRec(stageRow(6, "shipped"), "it worked.")]]),
				open: new Set([6]),
				checks: [{issue: 6, section: "Tails", rec: "check it.", plainWords: "Issue 6"}],
			}),
		);

		expect(recWrites(plan)).toEqual([]);
		expect(plan.kept.map((one) => one.issue)).toEqual([6]);
	});

	it("writes prep's text into an empty Rec, and names nothing", () => {
		const plan = prepPlan(
			input({
				rows: new Map([
					[1, stageRow(1, "proposed")],
					[6, stageRow(6, "shipped")],
				]),
				open: new Set([1, 6]),
				agenda: [{issue: 1, section: "Tails", group: single(1), flaggedBet: false, cells}],
				checks: [{issue: 6, section: "Tails", rec: "check it.", plainWords: "Issue 6"}],
			}),
		);

		expect(recWrites(plan)).toMatchObject([
			{_tag: "Set", issue: 1, value: {_tag: "Text", text: "yes."}},
			{_tag: "Set", issue: 6, value: {_tag: "Text", text: "check it."}},
		]);
		expect(plan.kept).toEqual([]);
	});

	it("names no row whose Rec already reads as prep's text", () => {
		const plan = prepPlan(
			input({
				rows: new Map([[1, withRec(stageRow(1, "proposed"), "yes.")]]),
				open: new Set([1]),
				agenda: [{issue: 1, section: "Tails", group: single(1), flaggedBet: false, cells}],
			}),
		);

		expect(recWrites(plan)).toEqual([]);
		expect(plan.kept).toEqual([]);
	});
});
