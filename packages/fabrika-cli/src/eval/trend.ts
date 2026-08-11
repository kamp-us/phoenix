/**
 * The trend co-gate — is a cell's graded pass rate declining over the trailing two weeks (#4680)?
 *
 * The arithmetic is ADR 0252 §3's and is not re-derived here: one series per
 * `(stage × surface × model)` cell, a window anchored on the newest point rather than on wall-clock
 * now, three points minimum in each half, and two strict clauses. Both clauses being strict is the
 * part a reader is most likely to get wrong — a drop of exactly five points is `steady`.
 *
 * **It ships observe-only** (#4766 founder guardrail: "it must never red a PR until it has been
 * observed working on real data first"). This module answers; nothing here decides an exit status, and
 * the verb that calls it exits `0` on all three answers. Arming is a separate, later ADR ruled on the
 * observe-only record.
 *
 * `insufficient-data` is a third answer, not a pass. A window nobody can read is unknown, and folding
 * it into `steady` is the zero-scope green ADR 0092 forbids.
 *
 * The one rounding is ADR 0252 §3's, applied to the half-mean difference immediately before the
 * comparison, and it is load-bearing: `0.05` is exactly one regressing case in a twenty-case corpus,
 * and in IEEE-754 two arithmetically identical one-case regressions land on opposite sides of the
 * constant. It reuses the record's own `roundRate` so the package keeps one rounding.
 */
import {roundRate} from "../wire/eval-record.ts";
import {type CommittedScorecard, cellKeyOf, cellLabel} from "./committed-scorecard.ts";

/** ADR 0252 §3's calibration. Provisional by that record's own terms — changing one is a decision. */
export const WINDOW_DAYS = 14;
export const HALF_DAYS = 7;
export const MINIMUM_HALF_POINTS = 3;
export const DECLINE_THRESHOLD = 0.05;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One committed scorecard's contribution to one cell's series. */
export interface SeriesPoint {
	readonly fileName: string;
	/** The scorecard's own stamp — the ordering key, never the cell's source record's. */
	readonly recordedAt: string;
	readonly passRate: number;
	/** The head the underlying eval record was bound to, so a point traces back to a tree. */
	readonly sourceSha: string;
}

export interface CellSeries {
	readonly key: string;
	readonly cell: {readonly stage: string; readonly surface: string | null; readonly model: string};
	readonly points: ReadonlyArray<SeriesPoint>;
}

const byRecordedAtThenName = (a: SeriesPoint, b: SeriesPoint): number =>
	a.recordedAt === b.recordedAt
		? a.fileName.localeCompare(b.fileName)
		: a.recordedAt.localeCompare(b.recordedAt);

/**
 * Split the committed files into one series per cell.
 *
 * An `UNRECORDABLE` cell contributes **no point**: it is a run that measured nothing, and giving it a
 * `0.0` would manufacture the decline the co-gate is looking for. It stays visible in the file as a
 * broken run — this only declines to score it.
 */
export const buildSeries = (
	files: ReadonlyArray<{readonly fileName: string; readonly scorecard: CommittedScorecard}>,
): ReadonlyArray<CellSeries> => {
	const byKey = new Map<string, {cell: CellSeries["cell"]; points: Array<SeriesPoint>}>();
	for (const file of files) {
		for (const cell of file.scorecard.cells) {
			if (cell.outcome !== "RECORDED") continue;
			const key = cellKeyOf(cell);
			let entry = byKey.get(key);
			if (entry === undefined) {
				entry = {cell: {stage: cell.stage, surface: cell.surface, model: cell.model}, points: []};
				byKey.set(key, entry);
			}
			entry.points.push({
				fileName: file.fileName,
				recordedAt: file.scorecard.recordedAt,
				passRate: cell.passRate,
				sourceSha: cell.source.sha,
			});
		}
	}
	return [...byKey.entries()]
		.map(([key, entry]) => ({
			key,
			cell: entry.cell,
			points: [...entry.points].sort(byRecordedAtThenName),
		}))
		.sort((a, b) => cellLabel(a.cell).localeCompare(cellLabel(b.cell)));
};

export type TrendAnswer = "declining" | "steady" | "insufficient-data";

export interface TrendWindow {
	readonly start: string;
	readonly split: string;
	readonly end: string;
}

export interface TrendResult {
	readonly answer: TrendAnswer;
	/** The window read, or `null` when the series is empty and there is nothing to anchor on. */
	readonly window: TrendWindow | null;
	readonly olderCount: number;
	readonly newerCount: number;
	/** `mean(old) − mean(new)`, rounded exactly as clause 1 rounds it. Null below the minimum sample. */
	readonly meanDrop: number | null;
	/** Clause 2: every newer measurement below every older one. Null below the minimum sample. */
	readonly separated: boolean | null;
	readonly reason: string;
}

const mean = (values: ReadonlyArray<number>): number =>
	values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The two-week decline answer for one cell's series (ADR 0252 §3).
 *
 * The window is anchored on the newest point rather than on now, which is what makes the answer
 * reproducible from the committed files alone — the same property the head-bound verdict depends on.
 */
export const trendOf = (points: ReadonlyArray<SeriesPoint>): TrendResult => {
	const ordered = [...points].sort(byRecordedAtThenName);
	const newest = ordered[ordered.length - 1];
	if (newest === undefined) {
		return {
			answer: "insufficient-data",
			window: null,
			olderCount: 0,
			newerCount: 0,
			meanDrop: null,
			separated: null,
			reason: "the series carries no measured point — nothing to anchor a window on",
		};
	}

	const end = Date.parse(newest.recordedAt);
	const start = end - WINDOW_DAYS * DAY_MS;
	const split = end - HALF_DAYS * DAY_MS;
	const window: TrendWindow = {
		start: new Date(start).toISOString(),
		split: new Date(split).toISOString(),
		end: newest.recordedAt,
	};

	const at = (point: SeriesPoint): number => Date.parse(point.recordedAt);
	const older = ordered.filter((point) => at(point) >= start && at(point) < split);
	const newer = ordered.filter((point) => at(point) >= split && at(point) <= end);

	if (older.length < MINIMUM_HALF_POINTS || newer.length < MINIMUM_HALF_POINTS) {
		return {
			answer: "insufficient-data",
			window,
			olderCount: older.length,
			newerCount: newer.length,
			meanDrop: null,
			separated: null,
			reason: `the window holds ${older.length} older and ${newer.length} newer point(s); the criterion needs at least ${MINIMUM_HALF_POINTS} in each half`,
		};
	}

	const olderRates = older.map((point) => point.passRate);
	const newerRates = newer.map((point) => point.passRate);
	const meanDrop = roundRate(mean(olderRates) - mean(newerRates));
	const separated = Math.max(...newerRates) < Math.min(...olderRates);
	// Both clauses are strict, so a drop of exactly DECLINE_THRESHOLD is steady — one regressing case
	// in a twenty-case corpus is "something moved down", which clause 2 alone already tolerates.
	const declining = meanDrop > DECLINE_THRESHOLD && separated;

	return {
		answer: declining ? "declining" : "steady",
		window,
		olderCount: older.length,
		newerCount: newer.length,
		meanDrop,
		separated,
		reason: declining
			? `the half-means dropped ${meanDrop} (> ${DECLINE_THRESHOLD}) and the halves do not overlap`
			: meanDrop > DECLINE_THRESHOLD
				? `the half-means dropped ${meanDrop} but the halves overlap — scatter, not drift`
				: `the half-means dropped ${meanDrop}, which is not more than ${DECLINE_THRESHOLD}`,
	};
};

/** The advisory line ADR 0252 §4 specifies: the answer, the cell, and the window it read. */
export const renderTrendLine = (series: CellSeries, result: TrendResult): string => {
	const window =
		result.window === null
			? "no window"
			: `${result.window.start} … ${result.window.end}, split ${result.window.split}`;
	return `trend: ${result.answer} — ${cellLabel(series.cell)} over ${window} (${result.olderCount} older, ${result.newerCount} newer): ${result.reason}`;
};

export interface TrendReading {
	readonly series: CellSeries;
	readonly result: TrendResult;
}

/** Read every cell's series. Observe-only: the caller reports these and changes no exit status. */
export const readTrend = (
	files: ReadonlyArray<{readonly fileName: string; readonly scorecard: CommittedScorecard}>,
): ReadonlyArray<TrendReading> =>
	buildSeries(files).map((series) => ({series, result: trendOf(series.points)}));

/** The observe-only report: one line per cell, plus the note that it gates nothing. */
export const renderTrend = (readings: ReadonlyArray<TrendReading>): string =>
	[
		"fabrika trend co-gate — observe-only (ADR 0252 §4): it reports and never changes an exit status",
		...(readings.length === 0
			? ["trend: insufficient-data — the series carries no measured cell"]
			: readings.map((reading) => renderTrendLine(reading.series, reading.result))),
	].join("\n");

/** The machine-readable form, for a later arming decision to be ruled on. */
export const trendToJson = (readings: ReadonlyArray<TrendReading>): string =>
	`${JSON.stringify(
		{
			observeOnly: true,
			criterion: {
				windowDays: WINDOW_DAYS,
				halfDays: HALF_DAYS,
				minimumHalfPoints: MINIMUM_HALF_POINTS,
				declineThreshold: DECLINE_THRESHOLD,
				adr: 252,
			},
			cells: readings.map((reading) => ({
				stage: reading.series.cell.stage,
				surface: reading.series.cell.surface,
				model: reading.series.cell.model,
				points: reading.series.points.length,
				...reading.result,
			})),
		},
		null,
		2,
	)}\n`;
