/**
 * Which iteration prep readies, and the status update it renders when a number could not be
 * measured.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import {
	type Health,
	healthMarker,
	nextTableDay,
	postedFor,
	renderHealth,
	targetIteration,
} from "./health.ts";

const WEEK = {id: "it_28", title: "Sep 28", startDate: "2026-09-28", duration: 7};

describe("targetIteration", () => {
	it("readies the iteration the next table day falls in, today included", () => {
		expect(nextTableDay(SHIPPED_TABLE, new Date("2026-09-27T23:00:00Z")).toISOString()).toBe(
			"2026-09-28T00:00:00.000Z",
		);
		expect(nextTableDay(SHIPPED_TABLE, new Date("2026-09-28T09:00:00Z")).toISOString()).toBe(
			"2026-09-28T00:00:00.000Z",
		);
		expect(targetIteration([WEEK], SHIPPED_TABLE, new Date("2026-09-27T12:00:00Z"))).toEqual(WEEK);
	});

	it("is null when no iteration runs over the next table day", () => {
		expect(targetIteration([WEEK], SHIPPED_TABLE, new Date("2026-10-06T12:00:00Z"))).toBeNull();
	});
});

describe("renderHealth", () => {
	const quiet: Health = {
		lanes: 0,
		landed: 0,
		staleLanes: 0,
		spentUsd: 0,
		unmeasuredLanes: 0,
		founderLanes: 0,
		outside: {count: 0, kinds: {}, spentUsd: 0, unmeasured: 0},
		continuing: 0,
		flaggedBets: 0,
		inbox: 1,
	};

	it("says a week with no lane in words, never as a zero rate", () => {
		const update = renderHealth(quiet, WEEK, false);

		expect(update.body).toContain("- Land rate: no lane ended last week");
		expect(update.body).toContain("- Needed a founder: no lane ended last week");
		expect(update.body).toContain("- Inbox: 1 open issue with no labels");
		expect(update.status).toBe("ON_TRACK");
	});

	it("names spend it could not measure, and marks the update with its iteration", () => {
		const update = renderHealth({...quiet, lanes: 2, spentUsd: 10, unmeasuredLanes: 1}, WEEK, true);

		expect(update.body).toContain("- Spend: $10 measured, 1 lane not measured");
		expect(update.status).toBe("AT_RISK");
		expect(postedFor([{id: "SU", body: update.body, startDate: null}], WEEK.id)).toBe(true);
		expect(postedFor([{id: "SU", body: healthMarker("it_21"), startDate: null}], WEEK.id)).toBe(
			false,
		);
	});
});
