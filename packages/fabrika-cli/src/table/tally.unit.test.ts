/** What lane records add up to: one count per lane, a window from the bet, and honest spend. */
import {describe, expect, it} from "vitest";
import type {Instant, LaneRecord, Spent} from "../wire/lane-record.ts";
import {latestPerLane, tally} from "./tally.ts";

const record = (
	startedAt: string,
	terminalAt: string,
	spent: Spent,
	founderParks = 0,
): LaneRecord => ({
	issue: 7,
	outcome: "complete",
	startedAt: startedAt as Instant,
	terminalAt: terminalAt as Instant,
	builds: 1,
	reviews: 1,
	parks: Array.from({length: founderParks}, () => ({
		task: "issue",
		leaf: "blocked",
		cause: null,
		route: "founder" as const,
		at: terminalAt as Instant,
	})),
	spent,
	origin: "driver-pick",
	waiting: {_tag: "None"},
	prs: [],
	log: [],
});

const usd = (amount: number): Spent => ({_tag: "Measured", usd: amount});

describe("the lane tally", () => {
	it("counts a lane once, by its latest record, because each record carries the whole log", () => {
		const records = [
			record("2026-09-20T00:00:00Z", "2026-09-20T05:00:00Z", usd(4), 1),
			record("2026-09-20T00:00:00Z", "2026-09-21T05:00:00Z", usd(9), 2),
			record("2026-09-22T00:00:00Z", "2026-09-22T05:00:00Z", usd(1.25), 0),
		];

		expect(latestPerLane(records)).toHaveLength(2);
		expect(tally(records, null)).toEqual({
			lanes: 2,
			asks: 2,
			spend: {_tag: "Measured", usd: 10.25},
		});
	});

	it("counts only lanes ending at or after the window's start, so a new bet starts at 0", () => {
		const records = [
			record("2026-09-20T00:00:00Z", "2026-09-20T05:00:00Z", usd(4), 1),
			record("2026-09-23T00:00:00Z", "2026-09-23T05:00:00Z", usd(6), 1),
		];

		expect(tally(records, "2026-09-22T00:00:00Z")).toEqual({
			lanes: 1,
			asks: 1,
			spend: {_tag: "Measured", usd: 6},
		});
		expect(tally(records, "2026-09-30T00:00:00Z")).toEqual({
			lanes: 0,
			asks: 0,
			spend: {_tag: "Measured", usd: 0},
		});
	});

	it("is unmeasured when any counted lane is, rather than adding it as zero", () => {
		const records = [
			record("2026-09-20T00:00:00Z", "2026-09-20T05:00:00Z", usd(4)),
			record("2026-09-21T00:00:00Z", "2026-09-21T05:00:00Z", {
				_tag: "Unmeasured",
				reason: "no rate card",
			}),
		];

		expect(tally(records, null).spend).toEqual({_tag: "Unmeasured", lanes: 1, measuredUsd: 4});
	});
});
