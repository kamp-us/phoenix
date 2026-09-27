/**
 * `table flags` and the size stop against an in-memory table: thresholds read from `.fabrika.jsonc`,
 * a group row flagged once on its sums, a bet by an outside login flagged and left as set, the
 * table-wide checks on the whole-table run only, and a lane stopped at its stop multiple.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import {absent, present} from "../io/issues.ts";
import type {ItemFieldValue, ProjectItem, ProjectSnapshot, ProjectsAnswer} from "../io/projects.ts";
import {emit, type Instant, type LaneRecord} from "../wire/lane-record.ts";
import {NO_TARGET} from "./codes.ts";
import type {Campaigns} from "./flags.ts";
import {type FlagsBoard, runFlags} from "./flags-verb.ts";
import {readSizeStop} from "./size-stop.ts";
import type {SyncNode} from "./sync.ts";
import type {Located} from "./sync-verb.ts";

const REPO = "acme/widgets";
const OWNER = "octo-owner";
const NOW = new Date("2026-09-27T12:00:00.000Z");

const PROJECT: ProjectSnapshot = {
	id: "PVT_1",
	number: 3,
	url: "https://github.com/orgs/acme/projects/3",
	title: "widgets table",
	shortDescription: null,
	readme: null,
	fields: [],
	views: [],
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
	over: {located?: Located; campaigns?: Campaigns} = {},
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
	const board: FlagsBoard<never> = {
		locate: () => Effect.succeed(ok(over.located ?? {_tag: "Located", project: PROJECT})),
		items: () =>
			Effect.succeed(
				ok(
					rows.map(
						(row): ProjectItem => ({
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
							],
						}),
					),
				),
			),
		node: (_repo, number) => {
			const found = nodeOf(number);
			return Effect.succeed(found === null ? absent<SyncNode>() : present(found));
		},
		comments: (_repo, number) =>
			Effect.succeed({_tag: "Ok" as const, value: (issues[number]?.records ?? []).map(emit)}),
		week: () =>
			Effect.succeed(
				ok({
					running: [{id: "it_4", title: "Sep 21", startDate: "2026-09-21", duration: 7}],
					completed: [
						{id: "it_1", title: "Aug 31", startDate: "2026-08-31", duration: 7},
						{id: "it_2", title: "Sep 7", startDate: "2026-09-07", duration: 7},
						{id: "it_3", title: "Sep 14", startDate: "2026-09-14", duration: 7},
					],
				}),
			),
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
				{number: 10, stage: "bet", size: "S"},
				{number: 20, stage: "bet", size: "M"},
				{number: 21, stage: "in lane"},
				{number: 30, stage: "bet", setter: "drive-by"},
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
});
