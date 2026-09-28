/**
 * `table flags` and the size stop against an in-memory table: thresholds read from `.fabrika.jsonc`,
 * a group row flagged once on its sums, a bet by an outside login flagged and left as set, the
 * table-wide checks on the whole-table run only, and a lane stopped at its stop multiple.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import {absent, present} from "../io/issues.ts";
import type {ItemFieldValue, ProjectItem, ProjectSnapshot, ProjectsAnswer} from "../io/projects.ts";
import {emit, type Instant, type LaneRecord} from "../wire/lane-record.ts";
import {NO_TARGET} from "./codes.ts";
import type {Campaigns} from "./flags.ts";
import {type FlagsBoard, runFlags, shareWindow} from "./flags-verb.ts";
import {readSizeStop} from "./size-stop.ts";
import type {Row, SyncNode} from "./sync.ts";
import type {Located} from "./sync-verb.ts";

const REPO = "acme/widgets";
const OWNER = "octo-owner";
const NOW = new Date("2026-09-27T12:00:00.000Z");

const PROJECT: ProjectSnapshot = {
	id: "PVT_1",
	number: 3,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/3",
	title: "widgets table",
	shortDescription: null,
	readme: null,
	fields: [],
	views: [],
};

const ON_CALL: ProjectSnapshot = {
	...PROJECT,
	id: "PVT_2",
	number: 4,
	url: "https://github.com/orgs/acme/projects/4",
	title: "widgets on-call",
};

interface IssueSpec {
	readonly subIssues?: ReadonlyArray<number>;
	readonly blockedBy?: ReadonlyArray<number>;
	readonly parent?: number;
	readonly labels?: ReadonlyArray<string>;
	readonly records?: ReadonlyArray<LaneRecord>;
}

interface RowSpec {
	readonly number: number;
	readonly stage?: string;
	readonly setter?: string;
	readonly setAt?: string;
	readonly size?: string;
	/** The row's Table day, `YYYY-MM-DD`. */
	readonly tableDay?: string;
}

const optionValue = (
	name: string,
	option: string,
	creator: string,
	updatedAt: string,
): ItemFieldValue => ({
	fieldId: `F_${name}`,
	fieldName: name,
	value: {_tag: "Option", optionId: `${name}:${option}`, name: option},
	creator,
	updatedAt,
});

const table = (
	issues: Readonly<Record<number, IssueSpec>>,
	rows: ReadonlyArray<RowSpec>,
	over: {
		located?: Located;
		campaigns?: Campaigns;
		scopeMissing?: boolean;
		/** The on-call board's items: each issue with its target and when it was set. */
		onCall?: ReadonlyArray<{
			readonly number: number;
			readonly target: string;
			readonly since: string;
		}>;
		closed?: ReadonlyArray<number>;
	} = {},
) => {
	const ok = <A>(value: A): ProjectsAnswer<A> => ({_tag: "Ok", value});
	const nodeOf = (number: number): SyncNode | null => {
		const spec = issues[number];
		if (spec === undefined) return null;
		return {
			number,
			open: true,
			parent: spec.parent ?? null,
			subIssues: spec.subIssues ?? [],
			blockedBy: spec.blockedBy ?? [],
			blocking: Object.entries(issues)
				.filter(([, other]) => other.blockedBy?.includes(number))
				.map(([n]) => Number(n)),
		};
	};
	const productItems = (): ReadonlyArray<ProjectItem> =>
		rows.map((row) => ({
			itemId: `PVTI_${row.number}`,
			contentNumber: row.number,
			contentType: "Issue",
			repository: REPO,
			values: [
				...(row.stage === undefined
					? []
					: [
							optionValue(
								"Stage",
								row.stage,
								row.setter ?? OWNER,
								row.setAt ?? "2026-09-26T12:00:00.000Z",
							),
						]),
				...(row.size === undefined
					? []
					: [optionValue("Size", row.size, OWNER, "2026-09-20T00:00:00.000Z")]),
				...(row.tableDay === undefined
					? []
					: [
							{
								fieldId: "F_day",
								fieldName: "Table day",
								value: {_tag: "Date", date: row.tableDay},
								creator: OWNER,
								updatedAt: "2026-09-20T00:00:00.000Z",
							} satisfies ItemFieldValue,
						]),
			],
		}));
	const onCallItems = (): ReadonlyArray<ProjectItem> =>
		(over.onCall ?? []).map((item) => ({
			itemId: `PVTI_oncall_${item.number}`,
			contentNumber: item.number,
			contentType: "Issue",
			repository: REPO,
			values: [optionValue("Response target", item.target, OWNER, item.since)],
		}));
	const board: FlagsBoard<never> = {
		locate: (_repo, target) =>
			Effect.succeed(
				over.scopeMissing === true
					? {_tag: "MissingScope" as const, reason: "the token lacks the `project` scope"}
					: target.key.startsWith("boards.")
						? ok({_tag: "Located" as const, project: ON_CALL})
						: ok(over.located ?? {_tag: "Located", project: PROJECT}),
			),
		items: (projectId) =>
			Effect.succeed(ok(projectId === ON_CALL.id ? onCallItems() : productItems())),
		openIssues: () =>
			Effect.succeed({
				_tag: "Ok" as const,
				value: [...Object.keys(issues).map(Number), ...(over.onCall ?? []).map((one) => one.number)]
					.filter((number) => !(over.closed ?? []).includes(number))
					.map((number) => ({
						number,
						title: `Issue ${number}`,
						body: "",
						labels: issues[number]?.labels ?? [],
						author: OWNER,
						association: "MEMBER",
					})),
			}),
		node: (_repo, number) => {
			const found = nodeOf(number);
			return Effect.succeed(found === null ? absent<SyncNode>() : present(found));
		},
		comments: (_repo, number) =>
			Effect.succeed({_tag: "Ok" as const, value: (issues[number]?.records ?? []).map(emit)}),
		labels: (_repo, number) =>
			Effect.succeed({_tag: "Ok" as const, value: issues[number]?.labels ?? []}),
		deciders: () => Effect.succeed({_tag: "Roster" as const, logins: new Set([OWNER])}),
		campaigns: () =>
			Effect.succeed(over.campaigns ?? {_tag: "Read" as const, active: ["one", "two"]}),
	};
	return {board};
};

let lane = 0;
const record = (issue: number, usd: number, asks = 0, endedAt = "2026-09-27T06:00:00.000Z") => {
	const terminalAt = endedAt as Instant;
	return {
		issue,
		outcome: "complete",
		startedAt: new Date(Date.UTC(2026, 8, 1, 0, lane++)).toISOString() as Instant,
		terminalAt,
		builds: 1,
		reviews: 1,
		parks: Array.from({length: asks}, () => ({
			task: "issue",
			leaf: "blocked",
			cause: null,
			route: "founder" as const,
			at: terminalAt,
		})),
		spent: {_tag: "Measured", usd},
		origin: "bet",
		waiting: {_tag: "None"},
		prs: [],
		log: [],
	} satisfies LaneRecord;
};

const CONFIG = fakeFs({
	files: {
		"/repo/.fabrika.jsonc": JSON.stringify({
			table: {asksFlag: 2, activeCampaignFlag: 1, fabrikaShare: {labels: ["pipeline"]}},
			appetiteSizes: {S: 10, M: 20, L: 30},
		}),
	},
}).layer;

const flags = (board: FlagsBoard<never>, issues: ReadonlyArray<number> = [], config = CONFIG) =>
	Effect.runPromise(
		Effect.provide(
			runFlags({repo: REPO, cwd: "/repo", env: {}, issues, now: NOW, board}),
			Layer.mergeAll(config, fakeShell([]).layer),
		),
	);

describe("table flags on the whole table", () => {
	const world = () =>
		table(
			{
				10: {records: [record(10, 11)], labels: ["pipeline"]},
				20: {blockedBy: [21]},
				21: {records: [record(21, 3, 1), record(21, 1, 1)]},
				30: {records: [record(30, 2)]},
			},
			[
				{number: 10, stage: "bet", size: "S", tableDay: "2026-09-07"},
				{number: 20, stage: "bet", size: "M", tableDay: "2026-09-14"},
				{number: 21, stage: "in lane", tableDay: "2026-09-21"},
				{number: 30, stage: "bet", setter: "drive-by", tableDay: "2026-09-21"},
			],
		);

	it("reads every threshold from .fabrika.jsonc and names each flag with its rec", async () => {
		const out = await flags(world().board);

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer).toMatchObject({answer: "flagged", scope: "table", rows: [10, 20, 30]});
		expect(
			answer.flags.map((flag: {flag: string; head?: number}) => `${flag.flag} ${flag.head ?? ""}`),
		).toEqual(["over-size 10", "asks 20", "unknown-decider 30", "campaigns ", "fabrika-share "]);
		expect(answer.flags[0]).toMatchObject({limitUsd: 10, spentUsd: 11, stopped: false});
		expect(answer.flags[1]).toMatchObject({group: "chain", covers: [20, 21], asks: 2});
		expect(answer.flags[4]).toMatchObject({percent: 64.71, target: 40, table: 4});
		for (const flag of answer.flags) expect(flag.rec).toMatch(/\?$/);
	});

	it("keeps the shipped thresholds for a repo with no config", async () => {
		const out = await flags(world().board, [], unconfigured);
		const answer = JSON.parse(out.stdout);

		expect(answer.flags.map((flag: {flag: string}) => flag.flag)).toEqual(["unknown-decider"]);
		expect(answer.unread).toEqual([
			expect.objectContaining({check: "fabrika-share", reason: expect.stringContaining("labels")}),
		]);
	});

	it("refuses with the table's own no-target code when there is no table project", async () => {
		const {board} = table({}, [], {
			located: {_tag: "Refused", code: NO_TARGET, reason: "table flags: no table"},
		});

		expect((await flags(board)).code).toBe(NO_TARGET);
	});
});

describe("table flags with a boards block", () => {
	const SPLIT = fakeFs({
		files: {"/repo/.fabrika.jsonc": JSON.stringify({boards: {onCall: {spendShare: 30}}})},
	}).layer;
	const world = () =>
		table(
			{
				10: {records: [record(10, 60)]},
				20: {records: [record(20, 40)]},
			},
			[
				{number: 10, stage: "in lane"},
				{number: 20, stage: "in lane"},
			],
			{
				onCall: [
					{number: 10, target: "same day", since: "2026-09-26T00:00:00.000Z"},
					{number: 11, target: "this week", since: "2026-09-26T00:00:00.000Z"},
					{number: 12, target: "same day", since: "2026-09-20T00:00:00.000Z"},
				],
				closed: [12],
			},
		);

	it("flags an open on-call item past its target and on-call spend over its share", async () => {
		const answer = JSON.parse((await flags(world().board, [], SPLIT)).stdout);

		expect(
			answer.flags.map((flag: {flag: string; issue?: number}) => [flag.flag, flag.issue ?? null]),
		).toEqual([
			["past-target", 10],
			["on-call-share", null],
		]);
		expect(answer.flags[1]).toMatchObject({percent: 60, target: 30, onCallUsd: 60, totalUsd: 100});
	});

	it("asks no on-call check with one board", async () => {
		const answer = JSON.parse((await flags(world().board, [], unconfigured)).stdout);

		expect(answer.flags).toEqual([]);
		expect(answer.unread.map((one: {check: string}) => one.check)).toEqual(["fabrika-share"]);
	});
});

describe("table flags on named issues", () => {
	it("judges only the rows they reach and asks no table-wide check", async () => {
		const {board} = table(
			{10: {records: [record(10, 11)]}, 30: {records: [record(30, 99)]}},
			[
				{number: 10, stage: "bet", size: "S"},
				{number: 30, stage: "bet", size: "S"},
			],
			{campaigns: {_tag: "Read", active: ["a", "b", "c", "d", "e"]}},
		);

		const answer = JSON.parse((await flags(board, [10])).stdout);

		expect(answer).toMatchObject({scope: "issues", rows: [10], unread: []});
		expect(answer.flags.map((flag: {flag: string}) => flag.flag)).toEqual(["over-size"]);
	});
});

describe("the size stop", () => {
	const stop = (board: FlagsBoard<never>, issue: number, config = CONFIG) =>
		Effect.runPromise(
			Effect.provide(
				readSizeStop(board, "fabrika lane brief", "/repo", REPO, issue),
				Layer.mergeAll(config, fakeShell([]).layer),
			),
		);

	it("stops a member's lane once its epic row has spent its stop multiple", async () => {
		const {board} = table({1: {subIssues: [2]}, 2: {parent: 1, records: [record(2, 21)]}}, [
			{number: 1, stage: "bet", size: "S"},
			{number: 2, stage: "in lane"},
		]);

		expect(await stop(board, 2)).toMatchObject({
			_tag: "Stopped",
			flag: {head: 1, group: "epic", spentUsd: 21, limitUsd: 10, stopped: true},
		});
	});

	it("lets a lane over its size and short of the stop keep going", async () => {
		const {board} = table({10: {records: [record(10, 19)]}}, [
			{number: 10, stage: "bet", size: "S"},
		]);

		expect(await stop(board, 10)).toMatchObject({_tag: "Clear"});
	});

	it("is clear with no table project, and UNKNOWN on any other refusal", async () => {
		const none = table({}, [], {
			located: {_tag: "Refused", code: NO_TARGET, reason: "no table"},
		});
		const ambiguous = table({}, [], {
			located: {_tag: "Refused", code: 22, reason: "two tables"},
		});

		expect(await stop(none.board, 10)).toMatchObject({_tag: "Clear"});
		expect(await stop(ambiguous.board, 10)).toEqual({_tag: "Unknown", reason: "two tables"});
	});

	it("is Unchecked, never Clear, on a token without the project scope and no table block", async () => {
		const {board} = table({}, [], {scopeMissing: true});

		expect(await stop(board, 10, unconfigured)).toEqual({
			_tag: "Unchecked",
			reason: "fabrika lane brief: the token lacks the `project` scope",
		});
	});

	it("is Unchecked, never a refusal, on any other failed read with no table block", async () => {
		const {board} = table({10: {records: [record(10, 5)]}}, [
			{number: 10, stage: "bet", size: "S"},
		]);
		const rateLimited: FlagsBoard<never> = {
			...board,
			locate: () => Effect.succeed({_tag: "Failed", reason: "API rate limit exceeded"}),
		};
		const malformed: FlagsBoard<never> = {
			...board,
			comments: () => Effect.succeed({_tag: "Ok", value: ["lane-record: #10 complete @ never"]}),
		};

		expect(await stop(rateLimited, 10, unconfigured)).toMatchObject({
			_tag: "Unchecked",
			reason: expect.stringContaining("API rate limit exceeded"),
		});
		expect(await stop(malformed, 10, unconfigured)).toMatchObject({
			_tag: "Unchecked",
			reason: expect.stringContaining("does not read"),
		});
		expect(await stop(rateLimited, 10)).toMatchObject({_tag: "Unknown"});
		expect(await stop(malformed, 10)).toMatchObject({_tag: "Unknown"});
	});

	it("is UNKNOWN on a token without the project scope once a table block is declared", async () => {
		const {board} = table({}, [], {scopeMissing: true});

		expect(await stop(board, 10)).toMatchObject({_tag: "Unknown"});
	});
});

describe("the week the shares are judged over", () => {
	const row = (issue: number, date: string | null): Row => ({
		itemId: `PVTI_${issue}`,
		issue,
		values:
			date === null
				? []
				: [
						{
							fieldId: "F_day",
							fieldName: "Table day",
							value: {_tag: "Date", date},
							creator: OWNER,
							updatedAt: "2026-09-20T00:00:00.000Z",
						},
					],
	});

	it("is the 7 days ending at the next table day, numbered by the distinct Table days before it", () => {
		const rows = new Map([
			[1, row(1, "2026-09-14")],
			[2, row(2, "2026-09-21")],
			[3, row(3, "2026-09-21")],
			[4, row(4, "2026-09-28")],
			[5, row(5, null)],
		]);

		expect(shareWindow(SHIPPED_TABLE, rows, NOW)).toEqual({
			start: "2026-09-21T00:00:00.000Z",
			end: "2026-09-28T00:00:00.000Z",
			table: 3,
		});
		expect(
			shareWindow({...SHIPPED_TABLE, timeZone: "America/Los_Angeles"}, new Map(), NOW),
		).toEqual({start: "2026-09-21T07:00:00.000Z", end: "2026-09-28T07:00:00.000Z", table: 1});
	});
});
