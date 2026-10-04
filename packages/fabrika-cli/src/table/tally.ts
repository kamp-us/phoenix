/**
 * What an issue's lane records add up to: spend, asks, and how many lanes ran.
 *
 * **A lane counts once, by its latest record.** A lane posts a record at every terminal it reaches,
 * and each record carries the lane's whole log, so a lane that parked and then finished has two
 * records whose counts overlap. Records sharing a `startedAt` are one lane; only the latest of them
 * is summed.
 *
 * **Spend is only a number when every record measured it.** A record says `unmeasured` when no
 * dollar figure exists, and adding it as zero would put a measured-looking total on the table that
 * nobody measured. So one unmeasured lane makes the whole tally unmeasured.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9856
 */

import {asksOf, type LaneRecord} from "../wire/lane-record.ts";

export type Spend =
	| {readonly _tag: "Measured"; readonly usd: number}
	/**
	 * `measuredUsd` is what the measured lanes add up to: a floor on the real spend, never the spend.
	 * It is what lets a flag prove a row over its size while one of its lanes went unmeasured.
	 */
	| {readonly _tag: "Unmeasured"; readonly lanes: number; readonly measuredUsd: number};

export interface Tally {
	/** Lanes counted: one per distinct `startedAt` inside the window. */
	readonly lanes: number;
	readonly asks: number;
	readonly spend: Spend;
}

export const EMPTY_TALLY: Tally = {lanes: 0, asks: 0, spend: {_tag: "Measured", usd: 0}};

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** The latest record of each lane, oldest lane first. */
export const latestPerLane = (records: ReadonlyArray<LaneRecord>): ReadonlyArray<LaneRecord> => {
	const byLane = new Map<string, LaneRecord>();
	for (const record of records) {
		const standing = byLane.get(record.startedAt);
		if (standing === undefined || Date.parse(record.terminalAt) > Date.parse(standing.terminalAt)) {
			byLane.set(record.startedAt, record);
		}
	}
	return [...byLane.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
};

/**
 * Sum `records` over the lanes whose latest terminal falls at or after `since`; `null` counts every
 * lane. A bet row passes the moment it became `bet`, so its spend starts at zero there.
 */
export const tally = (records: ReadonlyArray<LaneRecord>, since: string | null): Tally => {
	const from = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
	const lanes = latestPerLane(records).filter((record) => Date.parse(record.terminalAt) >= from);
	let usd = 0;
	let unmeasured = 0;
	for (const record of lanes) {
		if (record.spent._tag === "Measured") usd += record.spent.usd;
		else unmeasured += 1;
	}
	return {
		lanes: lanes.length,
		asks: lanes.reduce((sum, record) => sum + asksOf(record), 0),
		spend:
			unmeasured > 0
				? {_tag: "Unmeasured", lanes: unmeasured, measuredUsd: cents(usd)}
				: {_tag: "Measured", usd: cents(usd)},
	};
};

/** The dollars the measured lanes add up to — the whole spend when every lane was measured. */
export const measuredUsd = (spend: Spend): number =>
	spend._tag === "Measured" ? spend.usd : spend.measuredUsd;

export const addTallies = (a: Tally, b: Tally): Tally => ({
	lanes: a.lanes + b.lanes,
	asks: a.asks + b.asks,
	spend:
		a.spend._tag === "Unmeasured" || b.spend._tag === "Unmeasured"
			? {
					_tag: "Unmeasured",
					lanes:
						(a.spend._tag === "Unmeasured" ? a.spend.lanes : 0) +
						(b.spend._tag === "Unmeasured" ? b.spend.lanes : 0),
					measuredUsd: cents(measuredUsd(a.spend) + measuredUsd(b.spend)),
				}
			: {_tag: "Measured", usd: cents(a.spend.usd + b.spend.usd)},
});

/** The issue's own latest record across every lane, or `null` when it has none. */
export const latestRecord = (records: ReadonlyArray<LaneRecord>): LaneRecord | null =>
	records.reduce<LaneRecord | null>(
		(latest, record) =>
			latest === null || Date.parse(record.terminalAt) > Date.parse(latest.terminalAt)
				? record
				: latest,
		null,
	);
