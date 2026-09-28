/**
 * `table sync` against an in-memory table and issue graph: rows from lane records, un-bet lanes
 * under Outside the bets, a person's Stage left standing, group rows summed, and a second run that
 * writes nothing. Its reads run a few at a time and still refuse whole.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, unconfigured} from "../fakes.test-support.ts";
import {fail} from "../io/git.ts";
import {absent, present, unknown} from "../io/issues.ts";
import type {
	FieldValue,
	ItemFieldValue,
	ProjectItem,
	ProjectSnapshot,
	ProjectsAnswer,
} from "../io/projects.ts";
import {emit, type Instant, type LaneRecord, type Origin} from "../wire/lane-record.ts";
import {MALFORMED_RECORD, NO_TARGET, NOT_SET_UP, PRECONDITION_UNKNOWN} from "./codes.ts";
import {ORIGINS, STAGES} from "./shape.ts";
import type {SyncNode} from "./sync.ts";
import {
	GRAPH_CAP,
	type Located,
	READ_FAN_OUT,
	readNode,
	readRecords,
	readScope,
	runSync,
	type SyncBoard,
} from "./sync-verb.ts";

const REPO = "acme/widgets";
const BOT = "fabrika-bot";
const HUMAN = "octo-owner";

const option = (field: string, name: string): string => `${field}:${name}`;

const selectField = (id: string, name: string, names: ReadonlyArray<string>) => ({
	_tag: "SingleSelect" as const,
	id,
	databaseId: 0,
	name,
	options: names.map((n) => ({
		id: option(id, n),
		name: n,
		color: "GRAY" as const,
		description: "",
	})),
});

const PROJECT: ProjectSnapshot = {
	id: "PVT_1",
	number: 3,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/3",
	title: "widgets table",
	shortDescription: null,
	readme: null,
	fields: [
		{_tag: "Plain", databaseId: 0, id: "F_title", name: "Title", dataType: "TITLE"},
		selectField(
			"F_stage",
			"Stage",
			STAGES.map((stage) => stage.name),
		),
		selectField("F_section", "Section", ["Tails", "Customers", "New bets", "Outside the bets"]),
		{_tag: "Plain", databaseId: 0, id: "F_spent", name: "Spent $", dataType: "NUMBER"},
		{_tag: "Plain", databaseId: 0, id: "F_asks", name: "Asks", dataType: "NUMBER"},
		selectField(
			"F_origin",
			"Origin",
			ORIGINS.map((origin) => origin.name),
		),
	],
	views: [],
};

interface IssueSpec {
	readonly open?: boolean;
	readonly parent?: number;
	readonly subIssues?: ReadonlyArray<number>;
	readonly blockedBy?: ReadonlyArray<number>;
	readonly records?: ReadonlyArray<LaneRecord>;
	readonly comments?: ReadonlyArray<string>;
}

type Value = {name: string; value: ItemFieldValue["value"]; creator: string; updatedAt: string};

interface FakeItem {
	id: string;
	number: number | null;
	type: ProjectItem["contentType"];
	values: Value[];
}

let at = 0;
const clock = (): string => new Date(Date.UTC(2026, 8, 27, 12, 0, at++)).toISOString();

const fieldName = (id: string): string =>
	PROJECT.fields.find((field) => field.id === id)?.name ?? id;

const shownValue = (fieldId: string, value: FieldValue): ItemFieldValue["value"] => {
	switch (value._tag) {
		case "Option":
			return {_tag: "Option", optionId: value.optionId, name: value.optionId.split(":")[1] ?? ""};
		case "Number":
			return {_tag: "Number", number: value.number};
		case "Text":
			return {_tag: "Text", text: value.text};
		case "Date":
			return {_tag: "Date", date: value.date};
		case "Iteration":
			return {_tag: "Iteration", iterationId: value.iterationId, title: fieldId};
	}
};

/** An in-memory table and repository. Writes change what the next read returns. */
const world = (
	issues: Readonly<Record<number, IssueSpec>>,
	rows: ReadonlyArray<{
		number: number | null;
		type?: ProjectItem["contentType"];
		values?: Record<string, string | number>;
	}> = [],
	options: {merged?: ReadonlyArray<number>; project?: ProjectSnapshot | null} = {},
) => {
	const items: FakeItem[] = rows.map((row, index) => ({
		id: `PVTI_${index}`,
		number: row.number,
		type: row.type ?? "Issue",
		values: Object.entries(row.values ?? {}).map(([name, raw]) => {
			const field = PROJECT.fields.find((f) => f.name === name);
			const value: ItemFieldValue["value"] =
				typeof raw === "number"
					? {_tag: "Number", number: raw}
					: {_tag: "Option", optionId: option(field?.id ?? name, raw), name: raw};
			return {name, value, creator: HUMAN, updatedAt: "2026-09-25T00:00:00Z"};
		}),
	}));
	const writes: string[] = [];
	const ok = <A>(value: A): ProjectsAnswer<A> => ({_tag: "Ok", value});
	const nodeOf = (number: number): SyncNode | null => {
		const spec = issues[number];
		if (spec === undefined) return null;
		const blocking = Object.entries(issues)
			.filter(([, other]) => other.blockedBy?.includes(number))
			.map(([n]) => Number(n));
		return {
			number,
			open: spec.open ?? true,
			parent: spec.parent ?? null,
			subIssues: spec.subIssues ?? [],
			blockedBy: spec.blockedBy ?? [],
			blocking,
		};
	};
	const itemById = (id: string): FakeItem => {
		const item = items.find((candidate) => candidate.id === id);
		if (item === undefined) throw new Error(`no item ${id}`);
		return item;
	};
	const board: SyncBoard<never> = {
		locate: () =>
			Effect.succeed(
				ok<Located>(
					options.project === null
						? {_tag: "Refused", code: NO_TARGET, reason: "table sync: no table"}
						: {_tag: "Located", project: options.project ?? PROJECT},
				),
			),
		items: () =>
			Effect.sync(() =>
				ok(
					items.map(
						(item): ProjectItem => ({
							itemId: item.id,
							contentNumber: item.number,
							contentType: item.type,
							repository: item.number === null ? null : REPO,
							values: item.values.map((value) => ({
								fieldId: PROJECT.fields.find((f) => f.name === value.name)?.id ?? value.name,
								fieldName: value.name,
								value: value.value,
								creator: value.creator,
								updatedAt: value.updatedAt,
							})),
						}),
					),
				),
			),
		node: (_repo, number) => {
			const found = nodeOf(number);
			return Effect.succeed(found === null ? absent<SyncNode>() : present(found));
		},
		comments: (_repo, number) =>
			Effect.succeed({
				_tag: "Ok" as const,
				value: [...(issues[number]?.comments ?? []), ...(issues[number]?.records ?? []).map(emit)],
			}),
		merged: (_repo, pr) =>
			Effect.succeed({_tag: "Ok" as const, value: (options.merged ?? []).includes(pr)}),
		add: (_project, _repo, number) =>
			Effect.sync(() => {
				writes.push(`add #${number}`);
				const existing = items.find((item) => item.number === number);
				if (existing !== undefined) return ok(existing.id);
				const item: FakeItem = {id: `PVTI_new_${number}`, number, type: "Issue", values: []};
				items.push(item);
				return ok(item.id);
			}),
		set: (target, value) =>
			Effect.sync(() => {
				const item = itemById(target.itemId);
				const name = fieldName(target.fieldId);
				writes.push(`set ${item.number} ${name}`);
				item.values = [
					...item.values.filter((v) => v.name !== name),
					{name, value: shownValue(target.fieldId, value), creator: BOT, updatedAt: clock()},
				];
				return ok(item.id);
			}),
		clear: (target) =>
			Effect.sync(() => {
				const item = itemById(target.itemId);
				const name = fieldName(target.fieldId);
				writes.push(`clear ${item.number} ${name}`);
				item.values = item.values.filter((v) => v.name !== name);
				return ok(item.id);
			}),
	};
	const valuesOf = (number: number): Record<string, string | number> => {
		const item = items.find((candidate) => candidate.number === number);
		if (item === undefined) return {};
		return Object.fromEntries(
			item.values.map((v) => [
				v.name,
				v.value._tag === "Number" ? v.value.number : v.value._tag === "Option" ? v.value.name : "",
			]),
		);
	};
	return {board, items, writes, valuesOf};
};

const sync = (board: SyncBoard<never>, issues: ReadonlyArray<number> = []) =>
	Effect.runPromise(
		Effect.provide(
			runSync({repo: REPO, cwd: "/repo", env: {}, issues, board}),
			Layer.mergeAll(unconfigured, fakeShell([]).layer),
		),
	);

let tick = 0;
const laneRecord = (
	issue: number,
	over: {
		usd?: number | null;
		founderParks?: number;
		origin?: Origin;
		prs?: ReadonlyArray<number>;
		terminalAt?: string;
	} = {},
): LaneRecord => {
	const startedAt = new Date(Date.UTC(2026, 8, 26, 0, tick++)).toISOString() as Instant;
	const terminalAt = (over.terminalAt ??
		new Date(Date.UTC(2026, 8, 26, 6, tick++)).toISOString()) as Instant;
	return {
		issue,
		outcome: "complete",
		startedAt,
		terminalAt,
		builds: 1,
		reviews: 1,
		parks: Array.from({length: over.founderParks ?? 0}, () => ({
			task: "issue",
			leaf: "blocked",
			cause: null,
			route: "founder" as const,
			at: terminalAt,
		})),
		spent:
			over.usd === null
				? {_tag: "Unmeasured", reason: "no rate card"}
				: {_tag: "Measured", usd: over.usd ?? 5},
		origin: over.origin ?? "driver-pick",
		waiting: {_tag: "None"},
		prs: over.prs ?? [],
		log: [],
	};
};

describe("table sync after a lane posts its record", () => {
	it("puts the issue on the table with Spent $, Asks and Origin from the record", async () => {
		const table = world({
			42: {
				records: [laneRecord(42, {usd: 7.5, founderParks: 2, origin: "founder-start", prs: [50]})],
			},
		});

		const outcome = await sync(table.board, [42]);

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).answer).toBe("synced");
		expect(table.valuesOf(42)).toEqual({
			Stage: "in lane",
			Section: "Outside the bets",
			"Spent $": 7.5,
			Asks: 2,
			Origin: "hand-start",
		});
	});

	it("moves Stage to shipped once a pull request the record names has merged", async () => {
		const table = world({42: {records: [laneRecord(42, {prs: [50]})]}}, [], {merged: [50]});

		await sync(table.board, [42]);

		expect(table.valuesOf(42).Stage).toBe("shipped");
	});

	it("leaves Spent $ unwritten while a counted lane is unmeasured, and still writes Asks", async () => {
		const table = world({42: {records: [laneRecord(42, {usd: null, founderParks: 1})]}});

		await sync(table.board, [42]);

		expect(table.valuesOf(42)["Spent $"]).toBeUndefined();
		expect(table.valuesOf(42).Asks).toBe(1);
	});
});

describe("a person's Stage", () => {
	it.each(["bet", "not now"])("is never overwritten when it reads %s", async (stage) => {
		const table = world(
			{42: {records: [laneRecord(42, {prs: [50]})]}},
			[{number: 42, values: {Stage: stage}}],
			{
				merged: [50],
			},
		);

		await sync(table.board, [42]);

		expect(table.valuesOf(42).Stage).toBe(stage);
		expect(table.writes.filter((write) => write.endsWith("Stage"))).toEqual([]);
	});

	it("keeps a bet row out of Outside the bets, and counts spend only from the bet", async () => {
		const table = world(
			{
				42: {
					records: [
						laneRecord(42, {usd: 30, founderParks: 3, terminalAt: "2026-09-20T00:00:00.000Z"}),
						laneRecord(42, {usd: 4, founderParks: 1, terminalAt: "2026-09-26T00:00:00.000Z"}),
					],
				},
			},
			[{number: 42, values: {Stage: "bet"}}],
		);

		await sync(table.board, [42]);

		expect(table.valuesOf(42)).toMatchObject({Stage: "bet", "Spent $": 4, Asks: 1});
		expect(table.valuesOf(42).Section).toBeUndefined();
	});

	it("starts a fresh bet at 0 before any lane has run on it", async () => {
		const table = world({42: {}}, [{number: 42, values: {Stage: "bet", Section: "New bets"}}]);

		await sync(table.board, [42]);

		expect(table.valuesOf(42)).toEqual({Stage: "bet", Section: "New bets", "Spent $": 0, Asks: 0});
	});

	it("clears a bet's standing $0 once an unmeasured lane lands on it, never leaving it to read $0", async () => {
		const table = world({42: {records: [laneRecord(42, {usd: null, founderParks: 1})]}}, [
			{number: 42, values: {Stage: "bet", Section: "New bets", "Spent $": 0, Asks: 0}},
		]);

		await sync(table.board, [42]);

		expect(table.valuesOf(42)["Spent $"]).toBeUndefined();
		expect(table.valuesOf(42).Asks).toBe(1);
		expect(table.writes).toContain("clear 42 Spent $");
	});
});

describe("an epic row", () => {
	it("sums Spent $ and Asks over its open children, and its children carry no Section", async () => {
		const table = world(
			{
				10: {subIssues: [11, 12, 13], records: [laneRecord(10, {usd: 2, founderParks: 1})]},
				11: {parent: 10, records: [laneRecord(11, {usd: 3, founderParks: 1})]},
				12: {parent: 10, records: [laneRecord(12, {usd: 4})]},
				13: {parent: 10, open: false, records: [laneRecord(13, {usd: 100, founderParks: 9})]},
			},
			[{number: 12, values: {Section: "Outside the bets"}}],
		);

		const outcome = await sync(table.board, [10]);

		expect(table.valuesOf(10)).toMatchObject({Section: "Outside the bets", "Spent $": 9, Asks: 2});
		expect(table.valuesOf(11)).toMatchObject({"Spent $": 3, Asks: 1});
		expect(table.valuesOf(11).Section).toBeUndefined();
		expect(table.valuesOf(12).Section).toBeUndefined();
		expect(table.items.some((item) => item.number === 13)).toBe(false);
		expect(JSON.parse(outcome.stdout).groups).toEqual([
			{head: 10, kind: "epic", members: [11, 12]},
		]);
	});

	it("reaches the epic row from a child's own record", async () => {
		const table = world({
			10: {subIssues: [11]},
			11: {parent: 10, records: [laneRecord(11, {usd: 6, founderParks: 2})]},
		});

		await sync(table.board, [11]);

		expect(table.valuesOf(10)).toMatchObject({Section: "Outside the bets", "Spent $": 6, Asks: 2});
		expect(table.valuesOf(11).Section).toBeUndefined();
	});
});

describe("a chain row", () => {
	it("sums the row and its open blockers transitively, and its members carry no Section", async () => {
		const table = world(
			{
				1: {blockedBy: [2], records: [laneRecord(1, {usd: 1, founderParks: 1})]},
				2: {blockedBy: [3, 4], records: [laneRecord(2, {usd: 2})]},
				3: {records: [laneRecord(3, {usd: 3, founderParks: 1})]},
				4: {open: false, records: [laneRecord(4, {usd: 50})]},
			},
			[{number: 3, values: {Section: "New bets"}}],
		);

		const outcome = await sync(table.board, [1]);

		expect(table.valuesOf(1)).toMatchObject({Section: "Outside the bets", "Spent $": 6, Asks: 2});
		for (const member of [2, 3]) expect(table.valuesOf(member).Section).toBeUndefined();
		expect(table.items.some((item) => item.number === 4)).toBe(false);
		expect(JSON.parse(outcome.stdout).groups).toEqual([{head: 1, kind: "chain", members: [2, 3]}]);
	});

	it("updates the chain row above when a blocker's lane records", async () => {
		const table = world(
			{
				1: {blockedBy: [2]},
				2: {records: [laneRecord(2, {usd: 8, founderParks: 1})]},
			},
			[{number: 1, values: {Stage: "proposed", Section: "New bets"}}],
		);

		await sync(table.board, [2]);

		expect(table.valuesOf(1)).toMatchObject({Section: "New bets", "Spent $": 8, Asks: 1});
		expect(table.valuesOf(2).Section).toBeUndefined();
	});
});

describe("rows are real, open issues", () => {
	it("never adds a closed issue as a new row, and adds no draft", async () => {
		const table = world({42: {open: false, records: [laneRecord(42)]}}, [
			{number: null, type: "DraftIssue"},
		]);

		const outcome = await sync(table.board, [42]);

		expect(outcome.code).toBe(0);
		expect(table.writes).toEqual([]);
		expect(JSON.parse(outcome.stdout).skipped).toEqual([
			{issue: 42, reason: "closed and not on the table, so it is not added"},
		]);
		expect(table.items).toHaveLength(1);
	});

	it("still fills a closed issue that is already a row", async () => {
		const table = world({42: {open: false, records: [laneRecord(42, {usd: 2})]}}, [{number: 42}]);

		await sync(table.board, [42]);

		expect(table.valuesOf(42)).toMatchObject({Stage: "in lane", "Spent $": 2});
	});

	it("refuses a number that is no issue before writing anything", async () => {
		const table = world({});

		const outcome = await sync(table.board, [404]);

		expect(outcome.code).toBe(NO_TARGET);
		expect(table.writes).toEqual([]);
	});
});

describe("running sync twice", () => {
	it("writes nothing the second time", async () => {
		const table = world(
			{
				1: {blockedBy: [2], records: [laneRecord(1, {usd: 1, founderParks: 1, prs: [9]})]},
				2: {records: [laneRecord(2, {usd: 2})]},
				10: {subIssues: [11], records: [laneRecord(10)]},
				11: {parent: 10, records: [laneRecord(11)]},
			},
			[],
			{merged: [9]},
		);

		const first = await sync(table.board, [1, 10]);
		const written = table.writes.length;
		const second = await sync(table.board, [1, 10]);
		const all = await sync(table.board);

		expect(JSON.parse(first.stdout).answer).toBe("synced");
		expect(written).toBeGreaterThan(0);
		expect(JSON.parse(second.stdout).answer).toBe("unchanged");
		expect(JSON.parse(all.stdout).answer).toBe("unchanged");
		expect(table.writes).toHaveLength(written);
	});
});

describe("refusals", () => {
	it("names table setup when the project lacks a field sync writes", async () => {
		const table = world({42: {records: [laneRecord(42)]}}, [], {
			project: {...PROJECT, fields: PROJECT.fields.filter((field) => field.name !== "Asks")},
		});

		const outcome = await sync(table.board, [42]);

		expect(outcome.code).toBe(NOT_SET_UP);
		expect(outcome.stderr.join("\n")).toContain("fabrika table setup");
		expect(table.writes).toEqual([]);
	});

	it("refuses a lane record that does not read, before any write", async () => {
		const table = world({42: {comments: ["lane-record: #42 complete @ not-a-time"]}});

		const outcome = await sync(table.board, [42]);

		expect(outcome.code).toBe(MALFORMED_RECORD);
		expect(table.writes).toEqual([]);
	});
});

const WIDE = 200;
const numbers = Array.from({length: WIDE}, (_, index) => index + 1);

/** A 200-row table, every row an open issue carrying one lane record. */
const wideTable = () =>
	world(
		Object.fromEntries(numbers.map((n) => [n, {records: [laneRecord(n)]}])),
		numbers.map((number) => ({number})),
	);

/** Counts the reads in flight at once; each read waits a moment so its siblings can start. */
const inFlight = () => {
	let now = 0;
	let peak = 0;
	const seen: number[] = [];
	const track = <A>(issue: number, read: Effect.Effect<A>): Effect.Effect<A> =>
		Effect.gen(function* () {
			now++;
			peak = Math.max(peak, now);
			seen.push(issue);
			yield* Effect.sleep("1 millis");
			const answer = yield* read;
			now--;
			return answer;
		});
	return {track, peak: () => peak, seen};
};

describe("reading a 200-row table", () => {
	it("reads nodes and comments a few at a time, capped at READ_FAN_OUT, each issue once", async () => {
		const table = wideTable();
		const nodes = inFlight();
		const comments = inFlight();
		const board: SyncBoard<never> = {
			...table.board,
			node: (repo, n) => nodes.track(n, table.board.node(repo, n)),
			comments: (repo, n) => comments.track(n, table.board.comments(repo, n)),
		};
		const rows = new Set(numbers);

		const scoped = await Effect.runPromise(readScope(board, "table flags", REPO, numbers, rows));
		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		const read = await Effect.runPromise(readRecords(board, "table flags", REPO, scoped, rows));
		if (read._tag !== "Records") throw new Error(read.reason);

		expect(nodes.peak()).toBe(READ_FAN_OUT);
		expect(comments.peak()).toBe(READ_FAN_OUT);
		expect([...nodes.seen].sort((a, b) => a - b)).toEqual(numbers);
		expect([...comments.seen].sort((a, b) => a - b)).toEqual(numbers);
		expect(scoped.graph.size).toBe(WIDE);
		expect(read.records.size).toBe(WIDE);
	});

	it("keeps the shipped node's edge-list reads inside READ_FAN_OUT across a wave, not three times it", async () => {
		const reads = inFlight();
		const edges = inFlight();
		const edge = (_repo: string, n: number) =>
			reads.track(n, edges.track(n, Effect.succeed(present<ReadonlyArray<number>>([]))));
		const node = readNode({
			issue: (_repo, n) =>
				reads.track(
					n,
					Effect.succeed(
						present({isPullRequest: false, state: "open", parent: {_tag: "None"} as const}),
					),
				),
			subIssues: edge,
			blockedBy: edge,
			blocking: edge,
		});
		const board: SyncBoard<never> = {...wideTable().board, node};

		const scoped = await Effect.runPromise(
			readScope(board, "table flags", REPO, numbers, new Set(numbers)),
		);

		expect(scoped._tag).toBe("Graph");
		expect(edges.seen).toHaveLength(3 * WIDE);
		expect(edges.peak()).toBeGreaterThan(3);
		expect(edges.peak()).toBeLessThanOrEqual(READ_FAN_OUT);
		expect(reads.peak()).toBeLessThanOrEqual(READ_FAN_OUT);
	});

	it("refuses PRECONDITION_UNKNOWN and writes nothing when one node read fails mid-batch", async () => {
		const table = wideTable();
		const nodes = inFlight();
		const board: SyncBoard<never> = {
			...table.board,
			node: (repo, n) =>
				nodes.track(
					n,
					n === 57 ? Effect.succeed(unknown<SyncNode>("gh timed out")) : table.board.node(repo, n),
				),
		};

		const outcome = await sync(board);

		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("cannot read #57: gh timed out");
		expect(nodes.peak()).toBeGreaterThan(1);
		expect(table.writes).toEqual([]);
	});

	it("refuses PRECONDITION_UNKNOWN and writes nothing when one comment read fails mid-batch", async () => {
		const table = wideTable();
		const comments = inFlight();
		const board: SyncBoard<never> = {
			...table.board,
			comments: (repo, n) =>
				comments.track(
					n,
					n === 123
						? Effect.succeed(fail("listing came back short"))
						: table.board.comments(repo, n),
				),
		};

		const outcome = await sync(board);

		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("cannot read #123's comments");
		expect(comments.peak()).toBeGreaterThan(1);
		expect(table.writes).toEqual([]);
	});

	it("still refuses at GRAPH_CAP without reading past it", async () => {
		const seeds = Array.from({length: GRAPH_CAP}, (_, index) => index + 1);
		const head = GRAPH_CAP + 1;
		let reads = 0;
		const board: SyncBoard<never> = {
			...world({}).board,
			node: (_repo, n) =>
				Effect.sync(() => {
					reads++;
					return present<SyncNode>({
						number: n,
						open: true,
						parent: head,
						subIssues: [],
						blockedBy: [],
						blocking: [],
					});
				}),
		};

		const scoped = await Effect.runPromise(readScope(board, "table sync", REPO, seeds, new Set()));

		expect(scoped._tag).toBe("Refused");
		if (scoped._tag !== "Refused") return;
		expect(scoped.code).toBe(PRECONDITION_UNKNOWN);
		expect(scoped.reason).toContain(`reach past ${GRAPH_CAP} issues`);
		expect(reads).toBe(GRAPH_CAP);
	});
});
