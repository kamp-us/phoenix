/**
 * The weekly health numbers `table prep` posts as the project's status update, and the iteration
 * they belong to. Pure: it reads lane records, the flags and the rows, and renders one update.
 *
 * **One update per iteration.** The body carries a marker naming the iteration it was posted for,
 * so prep can read the project's updates and tell that this week's already stands. A number it
 * could not measure — a lane with no dollar figure, a week with no lane — is said in words, never
 * shown as a zero.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {OUTSIDE_THE_BETS, type TableSettings, WEEKDAYS} from "../config/keys/table.ts";
import type {BoardIteration, StatusUpdate, StatusUpdateInput} from "../io/projects.ts";
import {asksOf, type LaneRecord} from "../wire/lane-record.ts";
import {optionOf} from "./agenda.ts";
import {currentIteration} from "./bets.ts";
import {type Flag, weekLanes} from "./flags.ts";
import {FIELD} from "./shape.ts";
import type {Row} from "./sync.ts";

const DAY_MS = 86_400_000;

/** Lane outcomes that mean the work landed. */
const LANDED: ReadonlySet<string> = new Set(["complete", "board:landed"]);

/** The next table day on or after `now`, at midnight UTC. */
export const nextTableDay = (settings: TableSettings, now: Date): Date => {
	const ahead = (WEEKDAYS.indexOf(settings.day) - now.getUTCDay() + 7) % 7;
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead));
};

/** The iteration the next table day falls in, or `null` when the Week field runs none there. */
export const targetIteration = (
	running: ReadonlyArray<BoardIteration>,
	settings: TableSettings,
	now: Date,
): BoardIteration | null => currentIteration(running, nextTableDay(settings, now));

/** The week the health numbers cover: the one that ends where `target` starts. */
export const healthWindow = (
	target: BoardIteration,
): {readonly start: string; readonly end: string} => {
	const end = Date.parse(`${target.startDate}T00:00:00.000Z`);
	return {
		start: new Date(end - target.duration * DAY_MS).toISOString(),
		end: new Date(end).toISOString(),
	};
};

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

/** The Outside the bets rows whose issue is open and whose lane is running. */
export const outsideOf = (
	rows: ReadonlyMap<number, Row>,
	open: ReadonlySet<number>,
): OutsideTally => {
	const running = [...rows.values()].filter(
		(row) =>
			open.has(row.issue) &&
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
	readonly flags: ReadonlyArray<Flag>;
	readonly outside: OutsideTally;
	/** Running bets carried into the new iteration without an agenda row. */
	readonly continuing: number;
	/** Running bets the flags brought onto the agenda. */
	readonly flaggedBets: number;
	/** Open issues with no labels: the Inbox view's set. */
	readonly inbox: number;
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
}

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
		landed: lanes.filter((lane) => LANDED.has(lane.outcome)).length,
		staleLanes: input.flags.filter((flag) => flag._tag === "Stuck").length,
		spentUsd: cents(spentUsd),
		unmeasuredLanes,
		founderLanes: lanes.filter((lane) => asksOf(lane) > 0).length,
		outside: input.outside,
		continuing: input.continuing,
		flaggedBets: input.flaggedBets,
		inbox: input.inbox,
	};
};

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

const plural = (count: number, one: string, many = `${one}s`): string =>
	`${count} ${count === 1 ? one : many}`;

/** The line that names which iteration an update was posted for. */
export const healthMarker = (iterationId: string): string =>
	`<!-- fabrika:table-health iteration=${iterationId} -->`;

/** Whether an update for `iterationId` already stands among `updates`. */
export const postedFor = (updates: ReadonlyArray<StatusUpdate>, iterationId: string): boolean =>
	updates.some((update) => update.body.includes(healthMarker(iterationId)));

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The status update for `target`: `AT_RISK` while any row flag stands, else `ON_TRACK`, dated over
 * the iteration.
 */
export const renderHealth = (
	health: Health,
	target: BoardIteration,
	flagged: boolean,
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
		`**Table notes, week of ${target.title}**`,
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
		"",
		healthMarker(target.id),
	];
	const start = Date.parse(`${target.startDate}T00:00:00.000Z`);
	return {
		body: lines.join("\n"),
		status: flagged ? "AT_RISK" : "ON_TRACK",
		startDate: target.startDate,
		targetDate: isoDay(start + target.duration * DAY_MS),
	};
};
