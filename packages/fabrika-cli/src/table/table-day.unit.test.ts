/**
 * The date math every table week is read through, pinned at the instant the Week iteration got
 * wrong: a Saturday evening in California, which is already Sunday in UTC.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE, type TableSettings} from "../config/keys/table.ts";
import {AGENDA_DAYS, VIEWS} from "./shape.ts";
import {
	agendaDays,
	currentTableDay,
	dayLabel,
	localDay,
	nextTableDay,
	parseTableDay,
	plusDays,
	startOf,
	type TableDay,
	tableNumber,
	weekBefore,
} from "./table-day.ts";

const PACIFIC = "America/Los_Angeles";
const SATURDAYS: TableSettings = {...SHIPPED_TABLE, day: "saturday", timeZone: PACIFIC};
const day = (text: string): TableDay => parseTableDay(text) as TableDay;

/** Saturday Oct 3 2026, 18:30 in California: Sunday Oct 4, 01:30 in UTC. */
const SATURDAY_EVENING_PT = new Date("2026-10-04T01:30:00Z");

describe("parseTableDay", () => {
	it("takes a real YYYY-MM-DD day and nothing else", () => {
		expect(parseTableDay("2026-10-03")).toBe("2026-10-03");
		expect(parseTableDay("2026-02-30")).toBeNull();
		expect(parseTableDay("2026-10-03T00:00:00Z")).toBeNull();
		expect(parseTableDay("Oct 3")).toBeNull();
	});
});

describe("a Saturday evening in California, already Sunday in UTC", () => {
	it("reads today in the table's zone, so the next table is still that Saturday", () => {
		expect(localDay(PACIFIC, SATURDAY_EVENING_PT)).toBe("2026-10-03");
		expect(localDay("UTC", SATURDAY_EVENING_PT)).toBe("2026-10-04");
		expect(nextTableDay(SATURDAYS, SATURDAY_EVENING_PT)).toBe("2026-10-03");
		expect(currentTableDay(SATURDAYS, SATURDAY_EVENING_PT)).toBe("2026-10-03");
	});

	it("puts prep's table, the health window and the Agenda view's days on the same table", () => {
		const target = nextTableDay(SATURDAYS, SATURDAY_EVENING_PT);
		const window = weekBefore(target, PACIFIC);
		const agenda = agendaDays(SATURDAYS, SATURDAY_EVENING_PT);

		expect(window).toEqual({start: "2026-09-26T07:00:00.000Z", end: "2026-10-03T07:00:00.000Z"});
		expect(agenda).toEqual({from: "2026-10-03", to: "2026-10-09"});
		expect(agenda.from <= target && target <= agenda.to).toBe(true);
		expect(window.end).toBe(startOf(target, PACIFIC));
		expect(VIEWS.find((view) => view.name === "Agenda")?.filter.startsWith(AGENDA_DAYS)).toBe(true);
		expect(AGENDA_DAYS).toBe("table-day:@today..@today+6d");
	});

	it("disagrees with the view when the table reads today in UTC, which is why the zone is set", () => {
		const utc = {...SATURDAYS, timeZone: "UTC"};
		const agenda = agendaDays(SATURDAYS, SATURDAY_EVENING_PT);
		const target = nextTableDay(utc, SATURDAY_EVENING_PT);

		expect(target).toBe("2026-10-10");
		expect(target <= agenda.to).toBe(false);
	});
});

describe("table days across a week", () => {
	it("finds the next table on or after today and the table in force on or before it", () => {
		const wednesday = new Date("2026-09-30T19:00:00Z");
		expect(nextTableDay(SATURDAYS, wednesday)).toBe("2026-10-03");
		expect(currentTableDay(SATURDAYS, wednesday)).toBe("2026-09-26");
		expect(nextTableDay(SHIPPED_TABLE, wednesday)).toBe("2026-10-05");
		expect(currentTableDay(SHIPPED_TABLE, wednesday)).toBe("2026-09-28");
	});

	it("starts a day at its midnight in the zone, across a daylight-saving change", () => {
		expect(startOf(day("2026-11-01"), PACIFIC)).toBe("2026-11-01T07:00:00.000Z");
		expect(startOf(day("2026-11-02"), PACIFIC)).toBe("2026-11-02T08:00:00.000Z");
		expect(startOf(day("2026-11-02"), "UTC")).toBe("2026-11-02T00:00:00.000Z");
	});

	it("counts which table a day is off the distinct earlier days on the board", () => {
		const board = [day("2026-09-19"), day("2026-09-26"), day("2026-09-26"), day("2026-10-10")];
		expect(tableNumber(board, day("2026-10-03"))).toBe(3);
		expect(tableNumber([], day("2026-10-03"))).toBe(1);
	});

	it("adds days and names a day the way the status update does", () => {
		expect(plusDays(day("2026-12-28"), 7)).toBe("2027-01-04");
		expect(dayLabel(day("2026-10-03"))).toBe("Oct 3");
	});
});
