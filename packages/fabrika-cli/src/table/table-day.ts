/**
 * A row's table is its **Table day**: the calendar day, `YYYY-MM-DD`, of the table it sits at. Every
 * week the table reasons about is date math over that day, done here and nowhere else.
 *
 * **"Today" is read in the table's time zone, never in UTC.** GitHub resolves a view filter's
 * `@today` to a calendar day that is not UTC's: observed on a throwaway project at
 * 2026-09-28T01:20Z, `table-day:@today` matched the row dated 2026-09-27, the Pacific day, not the
 * row dated 2026-09-28. So prep, the health window and the Agenda view agree on which table is next
 * only when fabrika reads today in the zone the people at the table use — `table.timeZone`. On a
 * Saturday evening in California that is still Saturday, and the next table is that same day.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import {type TableSettings, WEEKDAYS} from "../config/keys/table.ts";

/** What the date math reads off the table's settings: the weekday it meets, and its zone. */
export type TableClock = Pick<TableSettings, "day" | "timeZone">;

/** A calendar day as a GitHub DATE field holds it. Only {@link parseTableDay} and this module mint one. */
export type TableDay = string & {readonly TableDay: unique symbol};

const DAY_MS = 86_400_000;

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `text` as a table day, or `null` when it is not a real `YYYY-MM-DD` calendar day. */
export const parseTableDay = (text: string): TableDay | null => {
	const match = SHAPE.exec(text);
	if (match === null) return null;
	const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return new Date(at).toISOString().slice(0, 10) === text ? (text as TableDay) : null;
};

const midnightUtc = (day: TableDay): number => Date.parse(`${day}T00:00:00.000Z`);

const fromUtc = (ms: number): TableDay => new Date(ms).toISOString().slice(0, 10) as TableDay;

export const plusDays = (day: TableDay, days: number): TableDay =>
	fromUtc(midnightUtc(day) + days * DAY_MS);

const weekdayOf = (day: TableDay): number => new Date(midnightUtc(day)).getUTCDay();

const zoned = (timeZone: string): Intl.DateTimeFormat =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

/** The wall clock `instant` shows in `timeZone`, read as if it were UTC. */
const wallClock = (instant: number, timeZone: string): number => {
	const parts = zoned(timeZone).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((one) => one.type === type)?.value);
	return Date.UTC(
		part("year"),
		part("month") - 1,
		part("day"),
		part("hour"),
		part("minute"),
		part("second"),
	);
};

/** The calendar day `now` falls on in `timeZone`. */
export const localDay = (timeZone: string, now: Date): TableDay =>
	fromUtc(wallClock(now.getTime(), timeZone));

/** The instant `day` begins in `timeZone`, as an ISO timestamp. */
export const startOf = (day: TableDay, timeZone: string): string => {
	const guess = midnightUtc(day);
	const whole = (ms: number): number => ms - (((ms % 1000) + 1000) % 1000);
	const offset = (at: number): number => wallClock(at, timeZone) - whole(at);
	const first = guess - offset(guess);
	return new Date(guess - offset(first)).toISOString();
};

const target = (settings: TableClock): number => WEEKDAYS.indexOf(settings.day);

/** The next table: the table day on or after today, where prep puts its agenda. */
export const nextTableDay = (settings: TableClock, now: Date): TableDay => {
	const today = localDay(settings.timeZone, now);
	return plusDays(today, (target(settings) - weekdayOf(today) + 7) % 7);
};

/** The table in force: the table day on or before today, whose bets agents work. */
export const currentTableDay = (settings: TableClock, now: Date): TableDay => {
	const today = localDay(settings.timeZone, now);
	return plusDays(today, -((weekdayOf(today) - target(settings) + 7) % 7));
};

/** The 7 days that end where `day` begins: the week a table looks back on. */
export const weekBefore = (
	day: TableDay,
	timeZone: string,
): {readonly start: string; readonly end: string} => ({
	start: startOf(plusDays(day, -7), timeZone),
	end: startOf(day, timeZone),
});

/**
 * The days the Agenda view's `@today..@today+6d` spans now. It holds exactly one table day, and it
 * is {@link nextTableDay}'s, because both read today in the same zone.
 */
export const agendaDays = (
	settings: TableClock,
	now: Date,
): {readonly from: TableDay; readonly to: TableDay} => {
	const today = localDay(settings.timeZone, now);
	return {from: today, to: plusDays(today, 6)};
};

/** Which table `day` is, counting the distinct earlier table days on the board: 1 for the first. */
export const tableNumber = (days: Iterable<TableDay>, day: TableDay): number =>
	new Set([...days].filter((one) => one < day)).size + 1;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Oct 3`: how a table day reads in prose. */
export const dayLabel = (day: TableDay): string => {
	const date = new Date(midnightUtc(day));
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};
