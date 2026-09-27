/**
 * The table's flags over rows and lane records: over size (and the stop behind it), asks, stuck,
 * an unknown decider, too many campaigns and fabrika's share of the week — each judged once per
 * group row on its sums, and each with its rec.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_APPETITE_SIZES} from "../config/keys/appetite-sizes.ts";
import {type OnCallBoard, SHIPPED_ON_CALL} from "../config/keys/boards.ts";
import {SHIPPED_TABLE, type TableSettings} from "../config/keys/table.ts";
import type {Instant, LaneRecord, Waiting} from "../wire/lane-record.ts";
import {
	type Campaigns,
	type Deciders,
	type Flag,
	type FlagInput,
	flagsOf,
	type HeadRow,
	NOT_ASKED,
	type OnCallItem,
	type OnCallRead,
	recOf,
	type ShareWeek,
	shareTarget,
	stopOf,
} from "./flags.ts";
import type {Group} from "./group.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const OWNER = "octo-owner";

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let lane = 0;
const record = (
	issue: number,
	over: {
		usd?: number | null;
		asks?: number;
		endedDaysAgo?: number;
		waiting?: Waiting;
		cause?: string;
	} = {},
): LaneRecord => {
	const terminalAt = daysAgo(over.endedDaysAgo ?? 0.5) as Instant;
	return {
		issue,
		outcome: "complete",
		startedAt: new Date(Date.UTC(2026, 8, 1, 0, lane++)).toISOString() as Instant,
		terminalAt,
		builds: 1,
		reviews: 1,
		parks: [
			...Array.from({length: over.asks ?? 0}, () => ({
				task: "issue",
				leaf: "blocked",
				cause: null,
				route: "founder" as const,
				at: terminalAt,
			})),
			...(over.cause === undefined
				? []
				: [
						{
							task: "issue",
							leaf: "blocked",
							cause: over.cause,
							route: "driver" as const,
							at: terminalAt,
						},
					]),
		],
		spent:
			over.usd === null
				? {_tag: "Unmeasured", reason: "no rate card"}
				: {_tag: "Measured", usd: over.usd ?? 5},
		origin: "bet",
		waiting: over.waiting ?? {_tag: "None"},
		prs: [],
		log: [],
	};
};

const single = (head: number): Group => ({_tag: "Single", head});

const row = (group: Group, over: Partial<Omit<HeadRow, "group">> = {}): HeadRow => ({
	group,
	stage: {name: "bet", setter: OWNER, setAt: daysAgo(1)},
	size: "S",
	children: 0,
	memberStages: [],
	origin: "bet",
	...over,
});

const input = (
	rows: ReadonlyArray<HeadRow>,
	records: Readonly<Record<number, ReadonlyArray<LaneRecord>>>,
	over: {
		settings?: Partial<TableSettings>;
		deciders?: Deciders;
		campaigns?: Campaigns;
		share?: ShareWeek;
		onCall?: OnCallRead;
	} = {},
): FlagInput => ({
	onCall: over.onCall ?? NOT_ASKED,
	settings: {...SHIPPED_TABLE, ...over.settings},
	sizes: SHIPPED_APPETITE_SIZES,
	now: NOW,
	rows,
	records: new Map(Object.entries(records).map(([issue, list]) => [Number(issue), list])),
	deciders: over.deciders ?? {_tag: "Roster", logins: new Set([OWNER])},
	campaigns: over.campaigns ?? NOT_ASKED,
	share: over.share ?? NOT_ASKED,
});

const named = (report: ReturnType<typeof flagsOf>) =>
	report.flags.map((flag) => ("head" in flag ? `${flag._tag} #${flag.head}` : flag._tag));

describe("over size", () => {
	it("flags a bet whose Spent $ passes its size's dollars, and it has not stopped", () => {
		const report = flagsOf(input([row(single(10))], {10: [record(10, {usd: 16})]}));

		expect(report.flags).toEqual([
			expect.objectContaining({
				_tag: "OverSize",
				head: 10,
				size: "S",
				limitUsd: 15,
				spentUsd: 16,
				stopped: false,
			}),
		]);
		expect(recOf(report.flags[0] as never, SHIPPED_TABLE)).toContain("Extend, re-shape, or drop?");
	});

	it("does not flag a bet at exactly its size", () => {
		expect(flagsOf(input([row(single(10))], {10: [record(10, {usd: 15})]})).flags).toEqual([]);
	});

	it("reads `stopped` at the stop multiple, and the multiple is the configured one", () => {
		const records = {10: [record(10, {usd: 30})]};

		expect(flagsOf(input([row(single(10))], records)).flags[0]).toMatchObject({stopped: true});
		expect(
			flagsOf(input([row(single(10))], records, {settings: {stopMultiple: 3}})).flags[0],
		).toMatchObject({stopped: false});
	});

	it("counts only lanes that ended after the row became a bet", () => {
		const report = flagsOf(
			input([row(single(10))], {10: [record(10, {usd: 40, endedDaysAgo: 2})]}),
		);

		expect(report.flags).toEqual([]);
	});

	it("prices an epic row's size once per sub-issue", () => {
		const epic: Group = {_tag: "Epic", head: 1, members: [2, 3]};
		const rows = [row(epic, {size: "L", children: 2})];

		expect(
			flagsOf(input(rows, {2: [record(2, {usd: 50})], 3: [record(3, {usd: 25})]})).flags,
		).toEqual([]);
		expect(
			flagsOf(input(rows, {2: [record(2, {usd: 50})], 3: [record(3, {usd: 35})]})).flags,
		).toEqual([
			expect.objectContaining({_tag: "OverSize", group: "epic", limitUsd: 80, spentUsd: 85}),
		]);
	});

	it("proves a row over its size on the measured floor while a lane went unmeasured", () => {
		const report = flagsOf(
			input([row(single(10))], {10: [record(10, {usd: 20}), record(10, {usd: null})]}),
		);

		expect(report.flags[0]).toMatchObject({_tag: "OverSize", spentUsd: 20});
		expect(report.unread).toEqual([]);
	});

	it("names the check unread when the measured floor is within the size and a lane is unmeasured", () => {
		const report = flagsOf(
			input([row(single(10))], {10: [record(10, {usd: 4}), record(10, {usd: null})]}),
		);

		expect(report.flags).toEqual([]);
		expect(report.unread).toEqual([expect.objectContaining({check: "over-size", issue: 10})]);
	});

	it("leaves a row with no size, or one no longer live, alone", () => {
		const records = {10: [record(10, {usd: 99})], 11: [record(11, {usd: 99})]};
		const report = flagsOf(
			input(
				[
					row(single(10), {size: null}),
					row(single(11), {stage: {name: "shipped", setter: OWNER, setAt: daysAgo(1)}}),
				],
				records,
			),
		);

		expect(report.flags).toEqual([]);
	});
});

describe("the size stop", () => {
	it("stops a lane on the row it stands on once the row spent the stop multiple", () => {
		const epic: Group = {_tag: "Epic", head: 1, members: [2, 3]};
		const rows = [row(epic, {size: "S", children: 2})];
		const settings = {...SHIPPED_TABLE};
		const records = new Map([
			[2, [record(2, {usd: 40})]],
			[3, [record(3, {usd: 20})]],
		]);

		expect(stopOf(rows, {settings, sizes: SHIPPED_APPETITE_SIZES, records}, 3)).toMatchObject({
			head: 1,
			spentUsd: 60,
			limitUsd: 30,
			stopped: true,
		});
		expect(stopOf(rows, {settings, sizes: SHIPPED_APPETITE_SIZES, records}, 9)).toBeNull();
	});

	it("lets a lane over its size but short of the stop keep going", () => {
		const rows = [row(single(10))];
		const records = new Map([[10, [record(10, {usd: 20})]]]);

		expect(
			stopOf(rows, {settings: SHIPPED_TABLE, sizes: SHIPPED_APPETITE_SIZES, records}, 10),
		).toBeNull();
	});
});

describe("asks", () => {
	it("flags a bet at its third ask whatever its size", () => {
		const report = flagsOf(
			input([row(single(10), {size: null}), row(single(11), {size: "L"})], {
				10: [record(10, {asks: 2}), record(10, {asks: 1})],
				11: [record(11, {asks: 2})],
			}),
		);

		expect(named(report)).toEqual(["Asks #10"]);
		expect(report.flags[0]).toMatchObject({asks: 3});
	});

	it("flags at the configured count", () => {
		const report = flagsOf(
			input([row(single(11))], {11: [record(11, {asks: 2})]}, {settings: {asksFlag: 2}}),
		);

		expect(named(report)).toEqual(["Asks #11"]);
	});
});

describe("a group row", () => {
	const chain: Group = {_tag: "Chain", head: 20, members: [21, 22]};

	it("is judged on the sums across its members and flagged once, on the head", () => {
		const report = flagsOf(
			input([row(chain, {size: "S"})], {
				20: [record(20, {usd: 5, asks: 1})],
				21: [record(21, {usd: 6, asks: 1})],
				22: [record(22, {usd: 6, asks: 1})],
			}),
		);

		expect(named(report)).toEqual(["OverSize #20", "Asks #20"]);
		expect(report.flags[0]).toMatchObject({spentUsd: 17, group: "chain", covers: [20, 21, 22]});
		expect(report.flags[1]).toMatchObject({asks: 3});
	});

	it("is live when a member is in a lane though the head carries no Stage", () => {
		const report = flagsOf(
			input([row(chain, {stage: null, memberStages: ["in lane"]})], {
				21: [record(21, {usd: 20})],
			}),
		);

		expect(named(report)).toEqual(["OverSize #20"]);
	});

	it("is stuck only when every member is quiet past the stuck days", () => {
		const quiet = {
			20: [record(20, {endedDaysAgo: 6})],
			21: [record(21, {endedDaysAgo: 5})],
			22: [record(22, {endedDaysAgo: 4})],
		};
		const oneBusy = {...quiet, 22: [record(22, {endedDaysAgo: 1})]};
		const stale = {name: "bet", setter: OWNER, setAt: daysAgo(10)};

		expect(named(flagsOf(input([row(chain, {stage: stale, size: null})], quiet)))).toEqual([
			"Stuck #20",
		]);
		expect(named(flagsOf(input([row(chain, {stage: stale, size: null})], oneBusy)))).toEqual([]);
	});
});

describe("stuck", () => {
	const stale = {name: "in lane", setter: OWNER, setAt: daysAgo(10)};

	it("flags a lane idle past the stuck days, naming what it knows of the wait", () => {
		const report = flagsOf(
			input([row(single(10), {stage: stale, size: null})], {
				10: [record(10, {endedDaysAgo: 4, cause: "head-ci-red"})],
			}),
		);

		expect(report.flags).toEqual([
			expect.objectContaining({
				_tag: "Stuck",
				head: 10,
				quietDays: 4,
				waiting: "parked: head-ci-red",
			}),
		]);
		expect(recOf(report.flags[0] as never, SHIPPED_TABLE)).toBe(
			"Quiet for 4 days (parked: head-ci-red). Unblock, re-shape, or drop?",
		);
	});

	it("does not flag a lane waiting on something until a date still to come", () => {
		const waiting: Waiting = {
			_tag: "Until",
			on: "the vendor's API key",
			until: "2026-10-01T00:00:00.000Z" as Instant,
		};
		const report = flagsOf(
			input([row(single(10), {stage: stale, size: null})], {
				10: [record(10, {endedDaysAgo: 5, waiting})],
			}),
		);

		expect(report.flags).toEqual([]);
	});

	it("flags it once the declared date has passed, naming the wait", () => {
		const waiting: Waiting = {
			_tag: "Until",
			on: "the vendor's API key",
			until: "2026-09-25T00:00:00.000Z" as Instant,
		};
		const report = flagsOf(
			input([row(single(10), {stage: stale, size: null})], {
				10: [record(10, {endedDaysAgo: 5, waiting})],
			}),
		);

		expect(report.flags[0]).toMatchObject({
			_tag: "Stuck",
			waiting: "waited on the vendor's API key until 2026-09-25T00:00:00.000Z",
		});
	});

	it("does not flag a lane short of the stuck days, which are configurable", () => {
		const records = {10: [record(10, {endedDaysAgo: 4})]};
		const rows = [row(single(10), {stage: stale, size: null})];

		expect(flagsOf(input(rows, records, {settings: {stuckDays: 5}})).flags).toEqual([]);
	});
});

describe("an unknown decider", () => {
	it("flags a bet set by a login outside the control-plane set, and the row stays a bet", () => {
		const stage = {name: "bet", setter: "drive-by", setAt: daysAgo(1)};
		const rows = [row(single(10), {stage, size: null})];
		const report = flagsOf(input(rows, {}));

		expect(report.flags).toEqual([
			expect.objectContaining({_tag: "UnknownDecider", head: 10, setter: "drive-by"}),
		]);
		expect(rows[0]?.stage).toEqual(stage);
		expect(recOf(report.flags[0] as never, SHIPPED_TABLE)).toContain("the bet stands as set");
	});

	it("matches a control-plane login whatever its case", () => {
		const stage = {name: "bet", setter: "Octo-Owner", setAt: daysAgo(1)};

		expect(flagsOf(input([row(single(10), {stage, size: null})], {})).flags).toEqual([]);
	});

	it("names the check unread when the control-plane set did not read", () => {
		const report = flagsOf(
			input([row(single(10), {size: null})], {}, {deciders: {_tag: "Unread", reason: "no roster"}}),
		);

		expect(report.flags).toEqual([]);
		expect(report.unread).toEqual([{check: "unknown-decider", issue: null, reason: "no roster"}]);
	});
});

describe("campaigns", () => {
	it("flags more active campaigns than the configured count", () => {
		const active = ["a", "b", "c", "d"];

		expect(named(flagsOf(input([], {}, {campaigns: {_tag: "Read", active}})))).toEqual([
			"Campaigns",
		]);
		expect(
			flagsOf(input([], {}, {campaigns: {_tag: "Read", active: active.slice(0, 3)}})).flags,
		).toEqual([]);
		expect(
			flagsOf(input([], {}, {campaigns: {_tag: "Read", active}, settings: {activeCampaignFlag: 4}}))
				.flags,
		).toEqual([]);
	});
});

describe("fabrika's share of the week", () => {
	const week = (table: number, fabrika: ReadonlyArray<number>): ShareWeek => ({
		_tag: "Week",
		start: daysAgo(3),
		end: daysAgo(-4),
		table,
		fabrika: new Set(fabrika),
	});
	const records = {10: [record(10, {usd: 45})], 11: [record(11, {usd: 55})]};

	it("flags fabrika work over the first target in the first tables", () => {
		const report = flagsOf(input([], records, {share: week(2, [10])}));

		expect(report.flags).toEqual([
			{_tag: "FabrikaShare", percent: 45, target: 40, fabrikaUsd: 45, totalUsd: 100, table: 2},
		]);
	});

	it("uses the later target after the first tables", () => {
		expect(shareTarget(SHIPPED_TABLE, 4)).toBe(40);
		expect(shareTarget(SHIPPED_TABLE, 5)).toBe(30);
		expect(flagsOf(input([], records, {share: week(5, [])})).flags).toEqual([]);
		expect(named(flagsOf(input([], {11: records[11]}, {share: week(5, [11])})))).toEqual([
			"FabrikaShare",
		]);
	});

	it("counts only lanes that ended inside the week", () => {
		const older = {10: [record(10, {usd: 45, endedDaysAgo: 5})], 11: records[11]};

		expect(flagsOf(input([], older, {share: week(1, [10])})).flags).toEqual([]);
	});

	it("names the check unread when a lane of the week went unmeasured, or no label is declared", () => {
		const unmeasured = {...records, 12: [record(12, {usd: null})]};

		expect(flagsOf(input([], unmeasured, {share: week(1, [10])})).unread).toEqual([
			expect.objectContaining({check: "fabrika-share"}),
		]);
		expect(
			flagsOf(input([], records, {share: {_tag: "Unread", reason: "no label"}})).unread,
		).toEqual([{check: "fabrika-share", issue: null, reason: "no label"}]);
	});
});

describe("the on-call board", () => {
	const hoursAgo = (hours: number): string =>
		new Date(NOW.getTime() - hours * 3_600_000).toISOString();
	const board = (
		open: ReadonlyArray<OnCallItem>,
		issues: ReadonlyArray<number> = [],
		over: Partial<OnCallBoard> = {},
	): OnCallRead => ({
		_tag: "OnCall",
		settings: {...SHIPPED_ON_CALL, ...over},
		issues: new Set(issues),
		open,
		week: {_tag: "Week", start: daysAgo(3), end: daysAgo(-4)},
	});
	const item = (issue: number, name: string | null, since = hoursAgo(1)): OnCallItem => ({
		issue,
		target: name === null ? null : {name, since},
	});

	it("flags an open item that waited past its response target, and not one within it", () => {
		const waiting = [item(5, "same day", hoursAgo(30)), item(6, "this week", hoursAgo(30))];
		const report = flagsOf(input([], {}, {onCall: board(waiting)}));

		expect(report.flags).toEqual([
			{
				_tag: "PastTarget",
				issue: 5,
				target: "same day",
				hours: 24,
				since: hoursAgo(30),
				waitedHours: 30,
			},
		]);
		expect(recOf(report.flags[0] as Flag, SHIPPED_TABLE)).toContain('past its "same day" target');
	});

	it("names an item with no target, or one the config no longer names, unread rather than clear", () => {
		const report = flagsOf(input([], {}, {onCall: board([item(5, null), item(6, "someday")])}));

		expect(report.flags).toEqual([]);
		expect(report.unread.map((one) => [one.check, one.issue])).toEqual([
			["past-target", 5],
			["past-target", 6],
		]);
	});

	it("flags on-call spend over its configured share of the week", () => {
		const records = {10: [record(10, {usd: 30})], 11: [record(11, {usd: 70})]};

		expect(flagsOf(input([], records, {onCall: board([], [10])})).flags).toEqual([
			{_tag: "OnCallShare", percent: 30, target: 20, onCallUsd: 30, totalUsd: 100},
		]);
		const wider = board([], [10], {spendShare: 30});
		expect(flagsOf(input([], records, {onCall: wider})).flags).toEqual([]);
	});

	it("names the share unread when a lane of the week went unmeasured", () => {
		const records = {10: [record(10, {usd: 30})], 11: [record(11, {usd: null})]};

		expect(flagsOf(input([], records, {onCall: board([], [10])})).unread).toEqual([
			expect.objectContaining({check: "on-call-share"}),
		]);
	});

	it("asks nothing with one board", () => {
		const report = flagsOf(input([], {10: [record(10, {usd: 100})]}));

		expect(report.flags).toEqual([]);
		expect(report.unread).toEqual([]);
	});
});
