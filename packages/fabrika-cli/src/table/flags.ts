/**
 * The table's flags: what brings a row, or the table as a whole, back to the people who decide.
 *
 * Pure: it reads rows, their groups and their lane records, and names what needs a person. Nothing
 * here writes or reverts anything, because a flag is a question for the table and never an answer
 * to it. The one stop the rulings allow, a lane at {@link TableSettings.stopMultiple} times its
 * size, is read off the same {@link OverSize} flag, so the lane that stops and the row the table
 * sees flagged can never disagree.
 *
 * **A group row is judged once, on its sums.** Spent $ and Asks are summed over the head and every
 * member through {@link tallyOver}, the sum `table sync` writes, so a flag and the Spent $ column
 * name one number. A group is stuck only when its latest activity, across all of them, is old. A
 * member row is never flagged on its own.
 *
 * **A check that could not be read is `unread`, never clear.** A spend with an unmeasured lane, a
 * control-plane set that did not read, a roadmap that did not parse: each is named, so the reader
 * of the flags knows which question went unasked.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {type AppetiteSizes, SIZES, type Size} from "../config/keys/appetite-sizes.ts";
import type {OnCallBoard, ResponseTargets} from "../config/keys/boards.ts";
import type {TableSettings} from "../config/keys/table.ts";
import type {LaneRecord} from "../wire/lane-record.ts";
import {BET_STAGE} from "./bets.ts";
import {type Group, type GroupKind, issuesOf, kindOf} from "./group.ts";
import {ON_CALL_FIELD, targetsOf} from "./on-call.ts";
import {tallyOver} from "./sync.ts";
import {latestPerLane, latestRecord, measuredUsd} from "./tally.ts";

/** The Stage values that mean work is live: said yes to, or in a lane. */
export const LIVE_STAGES: ReadonlySet<string> = new Set([BET_STAGE, "in lane"]);

const DAY_MS = 86_400_000;

/** A row's Stage cell: its value, who set it, and when. */
export interface StageCell {
	readonly name: string;
	/** Who set the value, or `null` when GitHub names no actor. */
	readonly setter: string | null;
	readonly setAt: string;
}

/** One group row as the flags read it. */
export interface HeadRow {
	readonly group: Group;
	readonly stage: StageCell | null;
	readonly size: Size | null;
	/** Every sub-issue the head has, open or closed: an epic row's size is priced per child. */
	readonly children: number;
	/** The Stage values set on the group's member rows. */
	readonly memberStages: ReadonlyArray<string>;
	/** The head row's Origin option, or `null` when it has none. */
	readonly origin: string | null;
}

export const sizeOf = (name: string | null): Size | null =>
	(SIZES as ReadonlyArray<string | null>).includes(name) ? (name as Size) : null;

/** What a row may spend: its size's dollars, once per child on an epic row. */
export const limitOf = (row: Pick<HeadRow, "group" | "size" | "children">, sizes: AppetiteSizes) =>
	row.size === null
		? null
		: sizes[row.size] * (row.group._tag === "Epic" ? Math.max(1, row.children) : 1);

/**
 * A check nobody asked for: a narrowed run asks no table-wide question, and the config turns the
 * fabrika-share check off with no `table.fabrikaShare.labels`. It is neither passed nor unread.
 */
export interface NotAsked {
	readonly _tag: "NotAsked";
}

export const NOT_ASKED: NotAsked = {_tag: "NotAsked"};

export type Deciders =
	| {readonly _tag: "Roster"; readonly logins: ReadonlySet<string>}
	| {readonly _tag: "Unread"; readonly reason: string}
	| NotAsked;

export type Campaigns =
	| {readonly _tag: "Read"; readonly active: ReadonlyArray<string>}
	| {readonly _tag: "Unread"; readonly reason: string}
	| NotAsked;

/** The week the fabrika share is judged over, and which issues are fabrika's own work. */
export type ShareWeek =
	| {
			readonly _tag: "Week";
			readonly start: string;
			readonly end: string;
			/** Which table this is, counting the distinct Table day dates before it: 1 for the first. */
			readonly table: number;
			readonly fabrika: ReadonlySet<number>;
	  }
	| {readonly _tag: "Unread"; readonly reason: string}
	| NotAsked;

/** An open on-call item and the Response target it waits against, set at `since`; `null` when unset. */
export interface OnCallItem {
	readonly issue: number;
	readonly target: {readonly name: string; readonly since: string} | null;
}

/** The on-call board as the flags read it; asked only when a `boards` block splits the work. */
export type OnCallRead =
	| {
			readonly _tag: "OnCall";
			readonly settings: OnCallBoard;
			/** Every issue on the on-call board, open or closed: the lanes its share counts. */
			readonly issues: ReadonlySet<number>;
			readonly open: ReadonlyArray<OnCallItem>;
			/** The week the share is judged over. */
			readonly week:
				| {readonly _tag: "Week"; readonly start: string; readonly end: string}
				| {readonly _tag: "Unread"; readonly reason: string};
	  }
	| {readonly _tag: "Unread"; readonly reason: string}
	| NotAsked;

export interface FlagInput {
	readonly settings: TableSettings;
	readonly sizes: AppetiteSizes;
	readonly now: Date;
	readonly rows: ReadonlyArray<HeadRow>;
	/** Every lane record standing on each issue the rows stand for. */
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
	readonly deciders: Deciders;
	readonly campaigns: Campaigns;
	readonly share: ShareWeek;
	readonly onCall: OnCallRead;
}

/** Where a row flag lands: the head, what kind of row it is, and every issue it stands for. */
interface OnRow {
	readonly head: number;
	readonly group: GroupKind | null;
	readonly covers: ReadonlyArray<number>;
}

export interface OverSize extends OnRow {
	readonly _tag: "OverSize";
	readonly size: Size;
	readonly limitUsd: number;
	/** What the row spent; a floor when some lane went unmeasured. */
	readonly spentUsd: number;
	/** Whether the spend reached the stop multiple, where the lane stops. */
	readonly stopped: boolean;
}

export type Flag =
	| OverSize
	| (OnRow & {readonly _tag: "Asks"; readonly asks: number})
	| (OnRow & {
			readonly _tag: "Stuck";
			readonly quietSince: string;
			readonly quietDays: number;
			/** Why the row waits, when a record says so. */
			readonly waiting: string | null;
	  })
	| (OnRow & {readonly _tag: "UnknownDecider"; readonly setter: string | null})
	| {readonly _tag: "Campaigns"; readonly active: ReadonlyArray<string>; readonly cap: number}
	| {
			readonly _tag: "FabrikaShare";
			readonly percent: number;
			readonly target: number;
			readonly fabrikaUsd: number;
			readonly totalUsd: number;
			readonly table: number;
	  }
	| PastTarget
	| {
			readonly _tag: "OnCallShare";
			readonly percent: number;
			readonly target: number;
			readonly onCallUsd: number;
			readonly totalUsd: number;
	  };

/** An open on-call item that has waited longer than its Response target allows. */
export interface PastTarget {
	readonly _tag: "PastTarget";
	readonly issue: number;
	readonly target: string;
	readonly hours: number;
	/** When the target was set: when the item arrived on the on-call board. */
	readonly since: string;
	readonly waitedHours: number;
}

/** A check that could not be answered, and why. */
export interface Unread {
	readonly check:
		| "over-size"
		| "unknown-decider"
		| "campaigns"
		| "fabrika-share"
		| "past-target"
		| "on-call-share";
	readonly issue: number | null;
	readonly reason: string;
}

export interface FlagReport {
	readonly flags: ReadonlyArray<Flag>;
	readonly unread: ReadonlyArray<Unread>;
}

const onRow = (group: Group): OnRow => ({
	head: group.head,
	group: kindOf(group),
	covers: issuesOf(group),
});

const isLive = (row: HeadRow): boolean =>
	(row.stage !== null && LIVE_STAGES.has(row.stage.name)) ||
	row.memberStages.some((stage) => LIVE_STAGES.has(stage));

/** Where a row's count starts: the moment it became `bet`, or every lane when it is not bet. */
const sinceOf = (row: HeadRow): string | null =>
	row.stage?.name === BET_STAGE ? row.stage.setAt : null;

const recordsOf = (issues: ReadonlyArray<number>, input: Pick<FlagInput, "records">) =>
	issues.flatMap((issue) => input.records.get(issue) ?? []);

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** A row's spend against its size. */
export type SizeRead =
	/** The row has no size, or spent no more than it. */
	| {readonly _tag: "Within"}
	| {readonly _tag: "Over"; readonly flag: OverSize}
	/** Within its size on what was measured, with a lane unmeasured: over or not is unknown. */
	| {readonly _tag: "Unmeasured"; readonly unread: Unread};

/**
 * One row's spend against its size. The measured dollars are a floor on the real spend, so a floor
 * already past the size proves the row over it even while a lane went unmeasured.
 */
export const sizeReadOf = (
	row: HeadRow,
	input: Pick<FlagInput, "settings" | "sizes" | "records">,
): SizeRead => {
	const limit = limitOf(row, input.sizes);
	if (row.size === null || limit === null) return {_tag: "Within"};
	const spend = tallyOver(issuesOf(row.group), input.records, sinceOf(row)).spend;
	const spent = measuredUsd(spend);
	if (spent > limit * input.settings.flagMultiple) {
		return {
			_tag: "Over",
			flag: {
				_tag: "OverSize",
				...onRow(row.group),
				size: row.size,
				limitUsd: limit,
				spentUsd: spent,
				stopped: spent >= limit * input.settings.stopMultiple,
			},
		};
	}
	return spend._tag === "Unmeasured"
		? {
				_tag: "Unmeasured",
				unread: {
					check: "over-size",
					issue: row.group.head,
					reason: `${spend.lanes} lane(s) went unmeasured and the measured $${spent} is within its flag point, ${input.settings.flagMultiple}x its $${limit} size`,
				},
			}
		: {_tag: "Within"};
};

/** The latest moment anything happened on the row: a lane ending, or its Stage being set. */
const lastActivity = (row: HeadRow, records: ReadonlyArray<LaneRecord>): number | null => {
	const moments = [
		...records.map((record) => Date.parse(record.terminalAt)),
		...(row.stage === null ? [] : [Date.parse(row.stage.setAt)]),
	].filter((moment) => !Number.isNaN(moment));
	return moments.length === 0 ? null : Math.max(...moments);
};

/** Why the row waits, off its issues' latest records: a lapsed declared wait, else a named park. */
const waitingReason = (latest: ReadonlyArray<LaneRecord>): string | null => {
	const newestFirst = [...latest].sort(
		(a, b) => Date.parse(b.terminalAt) - Date.parse(a.terminalAt),
	);
	for (const record of newestFirst) {
		if (record.waiting._tag === "Until") {
			return `waited on ${record.waiting.on} until ${record.waiting.until}`;
		}
	}
	for (const record of newestFirst) {
		const park = [...record.parks].reverse().find((one) => one.cause !== null);
		if (park !== undefined) return `parked: ${park.cause}`;
	}
	return null;
};

const stuckOf = (row: HeadRow, input: FlagInput): Flag | null => {
	const issues = issuesOf(row.group);
	const last = lastActivity(row, recordsOf(issues, input));
	if (last === null) return null;
	const quiet = input.now.getTime() - last;
	if (quiet < input.settings.stuckDays * DAY_MS) return null;
	const latest = issues.flatMap((issue) => {
		const record = latestRecord(input.records.get(issue) ?? []);
		return record === null ? [] : [record];
	});
	const declared = latest.some(
		(record) =>
			record.waiting._tag === "Until" && Date.parse(record.waiting.until) > input.now.getTime(),
	);
	if (declared) return null;
	return {
		_tag: "Stuck",
		...onRow(row.group),
		quietSince: new Date(last).toISOString(),
		quietDays: Math.floor(quiet / DAY_MS),
		waiting: waitingReason(latest),
	};
};

const rowFlags = (row: HeadRow, input: FlagInput, unread: Unread[]): ReadonlyArray<Flag> => {
	const flags: Flag[] = [];
	if (row.stage?.name === BET_STAGE && input.deciders._tag === "Roster") {
		const setter = row.stage.setter;
		const known = new Set([...input.deciders.logins].map((login) => login.toLowerCase()));
		if (setter === null || !known.has(setter.toLowerCase())) {
			flags.push({_tag: "UnknownDecider", ...onRow(row.group), setter});
		}
	}
	if (!isLive(row)) return flags;
	const size = sizeReadOf(row, input);
	if (size._tag === "Over") flags.push(size.flag);
	if (size._tag === "Unmeasured") unread.push(size.unread);
	const asks = tallyOver(issuesOf(row.group), input.records, sinceOf(row)).asks;
	if (asks >= input.settings.asksFlag) flags.push({_tag: "Asks", ...onRow(row.group), asks});
	const stuck = stuckOf(row, input);
	if (stuck !== null) flags.push(stuck);
	return flags;
};

/** The target share for `table`: the first share for the first tables, then the later one. */
export const shareTarget = (settings: TableSettings, table: number): number =>
	table <= settings.fabrikaShare.forTables
		? settings.fabrikaShare.percent
		: settings.fabrikaShare.thenPercent;

/** Each issue's lanes whose latest terminal falls inside the week. */
export const weekLanes = (
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
	week: {readonly start: string; readonly end: string},
): ReadonlyMap<number, ReadonlyArray<LaneRecord>> => {
	const from = Date.parse(week.start);
	const to = Date.parse(week.end);
	const lanes = new Map<number, ReadonlyArray<LaneRecord>>();
	for (const [issue, standing] of records) {
		const inWeek = latestPerLane(standing).filter((record) => {
			const at = Date.parse(record.terminalAt);
			return at >= from && at < to;
		});
		if (inWeek.length > 0) lanes.set(issue, inWeek);
	}
	return lanes;
};

const shareOf = (input: FlagInput, unread: Unread[]): Flag | null => {
	const week = input.share;
	if (week._tag === "NotAsked") return null;
	if (week._tag === "Unread") {
		unread.push({check: "fabrika-share", issue: null, reason: week.reason});
		return null;
	}
	let total = 0;
	let fabrika = 0;
	let unmeasured = 0;
	for (const [issue, lanes] of weekLanes(input.records, week)) {
		for (const lane of lanes) {
			if (lane.spent._tag === "Unmeasured") {
				unmeasured += 1;
				continue;
			}
			total += lane.spent.usd;
			if (week.fabrika.has(issue)) fabrika += lane.spent.usd;
		}
	}
	if (unmeasured > 0) {
		unread.push({
			check: "fabrika-share",
			issue: null,
			reason: `${unmeasured} lane(s) this week went unmeasured, so no share of the week's spend is known`,
		});
		return null;
	}
	if (total === 0) return null;
	const percent = cents((fabrika / total) * 100);
	const target = shareTarget(input.settings, week.table);
	return percent > target
		? {
				_tag: "FabrikaShare",
				percent,
				target,
				fabrikaUsd: cents(fabrika),
				totalUsd: cents(total),
				table: week.table,
			}
		: null;
};

/** Every flag the table raises, and every check it could not answer. */
export const flagsOf = (input: FlagInput): FlagReport => {
	const unread: Unread[] = [];
	const rows = [...input.rows].sort((a, b) => a.group.head - b.group.head);
	const flags: Flag[] = rows.flatMap((row) => rowFlags(row, input, unread));
	if (input.deciders._tag === "Unread" && rows.some((row) => row.stage?.name === BET_STAGE)) {
		unread.push({check: "unknown-decider", issue: null, reason: input.deciders.reason});
	}
	if (input.campaigns._tag === "Unread") {
		unread.push({check: "campaigns", issue: null, reason: input.campaigns.reason});
	} else if (
		input.campaigns._tag === "Read" &&
		input.campaigns.active.length > input.settings.activeCampaignFlag
	) {
		flags.push({
			_tag: "Campaigns",
			active: input.campaigns.active,
			cap: input.settings.activeCampaignFlag,
		});
	}
	const share = shareOf(input, unread);
	if (share !== null) flags.push(share);
	flags.push(...onCallFlags(input, unread));
	return {flags, unread};
};

const HOUR_MS = 3_600_000;

/** One open on-call item against its target: flagged once it has waited longer than the target. */
export const pastTargetOf = (
	item: OnCallItem,
	targets: ResponseTargets,
	now: Date,
):
	| {readonly _tag: "Past"; readonly flag: PastTarget}
	| {readonly _tag: "Within"}
	| {readonly _tag: "Unread"; readonly unread: Unread} => {
	const unread = (reason: string) =>
		({_tag: "Unread", unread: {check: "past-target", issue: item.issue, reason}}) as const;
	if (item.target === null) {
		return unread(
			`it carries no ${ON_CALL_FIELD.responseTarget} yet — \`fabrika table prep\` sets one`,
		);
	}
	const {name, since} = item.target;
	const target = targetsOf(targets).find((one) => one.name === name);
	if (target === undefined) {
		return unread(`its target "${name}" is not one \`boards.onCall.responseTargets\` names`);
	}
	const waited = (now.getTime() - Date.parse(since)) / HOUR_MS;
	return waited > target.hours
		? {
				_tag: "Past",
				flag: {
					_tag: "PastTarget",
					issue: item.issue,
					target: name,
					hours: target.hours,
					since,
					waitedHours: Math.floor(waited),
				},
			}
		: {_tag: "Within"};
};

/** What the week's lanes spent on on-call work, against everything they spent. */
export type OnCallSpend =
	| {
			readonly _tag: "Measured";
			readonly percent: number;
			readonly onCallUsd: number;
			readonly totalUsd: number;
	  }
	/** Some lane went unmeasured, so no share of the week is known. */
	| {readonly _tag: "Unmeasured"; readonly lanes: number}
	/** Nothing was spent that week. */
	| {readonly _tag: "Nothing"};

export const onCallSpendOf = (
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
	week: {readonly start: string; readonly end: string},
	onCall: ReadonlySet<number>,
): OnCallSpend => {
	let total = 0;
	let spent = 0;
	let unmeasured = 0;
	for (const [issue, lanes] of weekLanes(records, week)) {
		for (const lane of lanes) {
			if (lane.spent._tag === "Unmeasured") {
				unmeasured += 1;
				continue;
			}
			total += lane.spent.usd;
			if (onCall.has(issue)) spent += lane.spent.usd;
		}
	}
	if (unmeasured > 0) return {_tag: "Unmeasured", lanes: unmeasured};
	if (total === 0) return {_tag: "Nothing"};
	return {
		_tag: "Measured",
		percent: cents((spent / total) * 100),
		onCallUsd: cents(spent),
		totalUsd: cents(total),
	};
};

const onCallFlags = (input: FlagInput, unread: Unread[]): ReadonlyArray<Flag> => {
	const board = input.onCall;
	if (board._tag === "NotAsked") return [];
	if (board._tag === "Unread") {
		unread.push({check: "past-target", issue: null, reason: board.reason});
		unread.push({check: "on-call-share", issue: null, reason: board.reason});
		return [];
	}
	const flags: Flag[] = [];
	for (const item of [...board.open].sort((a, b) => a.issue - b.issue)) {
		const read = pastTargetOf(item, board.settings.responseTargets, input.now);
		if (read._tag === "Unread") unread.push(read.unread);
		if (read._tag === "Past") flags.push(read.flag);
	}
	if (board.week._tag === "Unread") {
		unread.push({check: "on-call-share", issue: null, reason: board.week.reason});
		return flags;
	}
	const spend = onCallSpendOf(input.records, board.week, board.issues);
	if (spend._tag === "Unmeasured") {
		unread.push({
			check: "on-call-share",
			issue: null,
			reason: `${spend.lanes} lane(s) this week went unmeasured, so no share of the week's spend is known`,
		});
	} else if (spend._tag === "Measured" && spend.percent > board.settings.spendShare) {
		flags.push({
			_tag: "OnCallShare",
			percent: spend.percent,
			target: board.settings.spendShare,
			onCallUsd: spend.onCallUsd,
			totalUsd: spend.totalUsd,
		});
	}
	return flags;
};

const TAG_NAME: Readonly<Record<Flag["_tag"], string>> = {
	OverSize: "over-size",
	Asks: "asks",
	Stuck: "stuck",
	UnknownDecider: "unknown-decider",
	Campaigns: "campaigns",
	FabrikaShare: "fabrika-share",
	PastTarget: "past-target",
	OnCallShare: "on-call-share",
};

export const flagName = (flag: Flag): string => TAG_NAME[flag._tag];

const times = (spent: number, limit: number): string => `${cents(spent / limit)}x`;

/** The one-line recommendation each flag carries onto the table. */
export const recOf = (flag: Flag, settings: TableSettings): string => {
	switch (flag._tag) {
		case "OverSize":
			return flag.stopped
				? `Stopped at ${times(flag.spentUsd, flag.limitUsd)} its ${flag.size} size ($${flag.spentUsd} of $${flag.limitUsd}); its lanes park until the table decides. Extend, re-shape, or drop?`
				: `Over its ${flag.size} size ($${flag.spentUsd} of $${flag.limitUsd}); it keeps going and stops at ${settings.stopMultiple}x. Extend, re-shape, or drop?`;
		case "Asks":
			return `Needed a person ${flag.asks} times. Keep going, re-shape, or drop?`;
		case "Stuck":
			return `Quiet for ${flag.quietDays} days${flag.waiting === null ? "" : ` (${flag.waiting})`}. Unblock, re-shape, or drop?`;
		case "UnknownDecider":
			return `Bet set by ${flag.setter === null ? "an account GitHub no longer names" : `@${flag.setter}`}, who is not a control-plane owner; the bet stands as set. Keep it, or set it back?`;
		case "Campaigns":
			return `${flag.active.length} campaigns are active, over the ${flag.cap} the table keeps. Which ones pause?`;
		case "FabrikaShare":
			return `fabrika's own work took ${flag.percent}% of this week's spend ($${flag.fabrikaUsd} of $${flag.totalUsd}), over the ${flag.target}% target. Fewer fabrika bets next table?`;
		case "PastTarget":
			return `Open on-call for ${flag.waitedHours} hours, past its "${flag.target}" target of ${flag.hours}. Pick it up now, or move it to the table?`;
		case "OnCallShare":
			return `On-call took ${flag.percent}% of the week's spend ($${flag.onCallUsd} of $${flag.totalUsd}), over its ${flag.target}% share. Raise the share, or fix what keeps breaking?`;
	}
};

/** Whether the rows standing for one issue stop its lane. */
export type StopRead =
	| {readonly _tag: "Stopped"; readonly flag: OverSize}
	| {readonly _tag: "Short"}
	/** Short of the stop on the measured floor, with a lane unmeasured: whether it reached it is unknown. */
	| {
			readonly _tag: "Unmeasured";
			readonly head: number;
			readonly lanes: number;
			readonly measuredUsd: number;
			readonly stopUsd: number;
	  };

/**
 * Whether a live row standing for `issue` spent its stop. It is the over-size flag itself, read for
 * one issue, so a lane stops exactly when its row reads `stopped`. A row short of the stop only on
 * its measured floor is `Unmeasured`, never `Short`, so no caller reads it as proven short.
 */
export const stopOf = (
	rows: ReadonlyArray<HeadRow>,
	input: Pick<FlagInput, "settings" | "sizes" | "records">,
	issue: number,
): StopRead => {
	let unmeasured: StopRead | null = null;
	for (const row of rows) {
		if (!isLive(row) || !issuesOf(row.group).includes(issue)) continue;
		const size = sizeReadOf(row, input);
		if (size._tag === "Over" && size.flag.stopped) return {_tag: "Stopped", flag: size.flag};
		const limit = limitOf(row, input.sizes);
		const spend = tallyOver(issuesOf(row.group), input.records, sinceOf(row)).spend;
		if (unmeasured === null && limit !== null && spend._tag === "Unmeasured") {
			unmeasured = {
				_tag: "Unmeasured",
				head: row.group.head,
				lanes: spend.lanes,
				measuredUsd: spend.measuredUsd,
				stopUsd: cents(limit * input.settings.stopMultiple),
			};
		}
	}
	return unmeasured ?? {_tag: "Short"};
};
