/**
 * The weekly health numbers `table prep` posts as the project's status update, and the table day
 * they belong to. Pure: it reads lane records, the flags and the rows, and renders one update.
 *
 * **One update per table.** The body carries a marker naming the table day it was posted for, so
 * prep can read the project's updates and tell that this table's already stands. A number it
 * could not measure — a lane with no dollar figure, a week with no lane — is said in words, never
 * shown as a zero. A flag check that could not be read is named in the update, never counted as no
 * flag, and the update is never `ON_TRACK` over it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import {OUTSIDE_THE_BETS} from "../config/keys/table.ts";
import type {StatusUpdate, StatusUpdateInput} from "../io/projects.ts";
import {asksOf, type LaneRecord} from "../wire/lane-record.ts";
import {optionOf} from "./agenda.ts";
import {type Flag, type FlagReport, type OnCallSpend, type Unread, weekLanes} from "./flags.ts";
import type {RuledUnbuilt} from "./ruled.ts";
import {FIELD} from "./shape.ts";
import type {Row} from "./sync.ts";
import {dayLabel, plusDays, type TableDay} from "./table-day.ts";

/** Lane outcomes that mean the work landed. */
const LANDED: ReadonlySet<string> = new Set(["complete", "board:landed"]);

export const isLanded = (lane: LaneRecord): boolean => LANDED.has(lane.outcome);

/** Un-bet lanes still running: how many, of which origin, and what they cost. */
export interface OutsideTally {
	readonly count: number;
	/** How many of them each origin started, by the Origin option's name. */
	readonly kinds: Readonly<Record<string, number>>;
	/** What the rows with a Spent $ figure add up to. */
	readonly spentUsd: number;
	/** How many rows carry no Spent $ figure. */
	readonly unmeasured: number;
}

const numberOf = (row: Row, field: string): number | null => {
	const value = row.values.find((one) => one.fieldName === field)?.value;
	return value?._tag === "Number" ? value.number : null;
};

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/**
 * The Outside the bets rows whose issue is open and whose lane is running. Issues in `onCall` are left
 * out: their spend is on-call's planned share, not unplanned work.
 */
export const outsideOf = (
	rows: ReadonlyMap<number, Row>,
	open: ReadonlySet<number>,
	onCall: ReadonlySet<number> = new Set(),
): OutsideTally => {
	const running = [...rows.values()].filter(
		(row) =>
			open.has(row.issue) &&
			!onCall.has(row.issue) &&
			optionOf(row, FIELD.section) === OUTSIDE_THE_BETS &&
			optionOf(row, FIELD.stage) === "in lane",
	);
	const kinds: Record<string, number> = {};
	let spentUsd = 0;
	let unmeasured = 0;
	for (const row of running) {
		const kind = optionOf(row, FIELD.origin) ?? "unknown";
		kinds[kind] = (kinds[kind] ?? 0) + 1;
		const spent = numberOf(row, FIELD.spent);
		if (spent === null) unmeasured += 1;
		else spentUsd += spent;
	}
	return {count: running.length, kinds, spentUsd: cents(spentUsd), unmeasured};
};

export interface HealthInput {
	readonly window: {readonly start: string; readonly end: string};
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
	readonly report: FlagReport;
	readonly outside: OutsideTally;
	/** Running bets carried to the new table without an agenda row. */
	readonly continuing: number;
	/** Running bets the flags brought onto the agenda. */
	readonly flaggedBets: number;
	/** Open issues with no labels: the Inbox view's set. */
	readonly inbox: number;
	/** Open issues whose ruling is not built yet, oldest ruling first. */
	readonly ruled: ReadonlyArray<RuledUnbuilt>;
}

export interface Health {
	/** Lanes whose latest record ended inside the window. */
	readonly lanes: number;
	readonly landed: number;
	readonly staleLanes: number;
	readonly spentUsd: number;
	readonly unmeasuredLanes: number;
	/** Lanes that needed a founder at least once. */
	readonly founderLanes: number;
	readonly outside: OutsideTally;
	readonly continuing: number;
	readonly flaggedBets: number;
	readonly inbox: number;
	readonly ruled: ReadonlyArray<RuledUnbuilt>;
	/** The flag checks that could not be read. */
	readonly unread: ReadonlyArray<Unread>;
}

/** How many items a flag names, or how many it proved while some item's check went unread. */
export type FlagCount =
	| {readonly _tag: "Counted"; readonly count: number}
	| {readonly _tag: "Unread"; readonly atLeast: number; readonly unread: number};

export const flagCount = (
	report: FlagReport,
	flag: Flag["_tag"],
	check: Unread["check"],
): FlagCount => {
	const count = report.flags.filter((one) => one._tag === flag).length;
	const unread = report.unread.filter((one) => one.check === check).length;
	return unread > 0 ? {_tag: "Unread", atLeast: count, unread} : {_tag: "Counted", count};
};

export const healthOf = (input: HealthInput): Health => {
	const lanes = [...weekLanes(input.records, input.window).values()].flat();
	let spentUsd = 0;
	let unmeasuredLanes = 0;
	for (const lane of lanes) {
		if (lane.spent._tag === "Measured") spentUsd += lane.spent.usd;
		else unmeasuredLanes += 1;
	}
	return {
		lanes: lanes.length,
		landed: lanes.filter(isLanded).length,
		staleLanes: input.report.flags.filter((flag) => flag._tag === "Stuck").length,
		spentUsd: cents(spentUsd),
		unmeasuredLanes,
		founderLanes: lanes.filter((lane) => asksOf(lane) > 0).length,
		outside: input.outside,
		continuing: input.continuing,
		flaggedBets: input.flaggedBets,
		inbox: input.inbox,
		ruled: input.ruled,
		unread: input.report.unread,
	};
};

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

const plural = (count: number, one: string, many = `${one}s`): string =>
	`${count} ${count === 1 ? one : many}`;

/** The line that names which table an update was posted for. */
export const healthMarker = (day: TableDay): string =>
	`<!-- fabrika:table-health table-day=${day} -->`;

/** Whether an update for the table on `day` already stands among `updates`. */
export const postedFor = (updates: ReadonlyArray<StatusUpdate>, day: TableDay): boolean =>
	updates.some((update) => update.body.includes(healthMarker(day)));

/** The on-call board as the table reviews it: one summary, never its rows. */
export interface OnCallHealth {
	readonly open: number;
	readonly pastTarget: FlagCount;
	/** On-call's spend over the same week as the table's numbers. */
	readonly spend: OnCallSpend;
	/** The planned share, in percent. */
	readonly share: number;
}

const onCallLines = (onCall: OnCallHealth): ReadonlyArray<string> => {
	const {spend} = onCall;
	const spent =
		spend._tag === "Measured"
			? `${spend.percent}% of the week's spend ($${spend.onCallUsd} of $${spend.totalUsd}), against a ${onCall.share}% share${spend.percent > onCall.share ? " — over it" : ""}`
			: spend._tag === "Unmeasured"
				? `not known, ${plural(spend.lanes, "lane")} not measured (share ${onCall.share}%)`
				: `no lane spent anything last week (share ${onCall.share}%)`;
	const {pastTarget} = onCall;
	const past =
		pastTarget._tag === "Unread"
			? ` (past their response target: not known, ${plural(pastTarget.unread, "item")} could not be checked${pastTarget.atLeast > 0 ? `, at least ${pastTarget.atLeast}` : ""})`
			: pastTarget.count > 0
				? ` (${pastTarget.count} past their response target)`
				: "";
	return [
		"",
		"**On-call** (one section; the table does not review it row by row)",
		"",
		`- Open items: ${onCall.open}${past}`,
		`- Spend: ${spent}`,
	];
};

const checkName = (one: Unread): string =>
	`${one.check}${one.issue === null ? "" : ` on #${one.issue}`}`;

/**
 * The status update for the table on `target`: `AT_RISK` while any flag stands or any flag check
 * could not be read, else `ON_TRACK`, dated over that table's week. With an on-call board it covers
 * that board too, as one closing section.
 */
export const renderHealth = (
	health: Health,
	target: TableDay,
	flagged: boolean,
	onCall: OnCallHealth | null = null,
): StatusUpdateInput => {
	const {outside} = health;
	const kinds = Object.entries(outside.kinds)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([kind, count]) => `${count} ${kind}`)
		.join(", ");
	const outsideCost =
		outside.unmeasured > 0
			? `$${outside.spentUsd} measured, ${plural(outside.unmeasured, "lane")} not measured`
			: `$${outside.spentUsd}`;
	const lines = [
		`**Table notes, week of ${dayLabel(target)}**`,
		"",
		health.lanes === 0
			? "- Land rate: no lane ended last week"
			: `- Land rate: ${percent(health.landed, health.lanes)} (${health.landed} of ${plural(health.lanes, "lane")} landed)`,
		`- Stale lanes: ${health.staleLanes}`,
		health.unmeasuredLanes > 0
			? `- Spend: $${health.spentUsd} measured, ${plural(health.unmeasuredLanes, "lane")} not measured`
			: `- Spend: $${health.spentUsd}`,
		health.lanes === 0
			? "- Needed a founder: no lane ended last week"
			: `- Needed a founder: ${percent(health.founderLanes, health.lanes)} of lanes (${health.founderLanes} of ${health.lanes})`,
		outside.count === 0
			? `- ${OUTSIDE_THE_BETS}: nothing running`
			: `- ${OUTSIDE_THE_BETS}: ${plural(outside.count, "lane")} (${kinds}), ${outsideCost}`,
		`- Bets continuing: ${health.continuing}${health.flaggedBets > 0 ? ` (and ${health.flaggedBets} flagged onto the agenda)` : ""}`,
		`- Inbox: ${plural(health.inbox, "open issue")} with no labels`,
		health.ruled.length === 0
			? "- Ruled, not built: none"
			: `- Ruled, not built, oldest ruling first: ${health.ruled.map((one) => `#${one.issue} (${one.ruledAt.slice(0, 10)})`).join(", ")}`,
		...(health.unread.length === 0
			? []
			: [
					`- Could not check: ${health.unread.map(checkName).join(", ")} — so the week is not called on track`,
				]),
		...(onCall === null ? [] : onCallLines(onCall)),
		"",
		healthMarker(target),
	];
	return {
		body: lines.join("\n"),
		status: flagged || health.unread.length > 0 ? "AT_RISK" : "ON_TRACK",
		startDate: target,
		targetDate: plusDays(target, 7),
	};
};
