/**
 * The trend co-gate's own tier — the discriminating test #4680's acceptance criteria ask for.
 *
 * Every series here is one of ADR 0252 §3's worked rows, written from that table rather than from a
 * reading of the prose. The row that carries the design is the **boundary**: halves cleanly separated
 * and a drop of exactly `0.05` is `steady`, because clause 1 is strict. A future edit that relaxes
 * either clause flips exactly that row.
 */
import {describe, expect, it} from "vitest";
import type {CommittedScorecard} from "./committed-scorecard.ts";
import {
	buildSeries,
	DECLINE_THRESHOLD,
	MINIMUM_HALF_POINTS,
	readTrend,
	renderTrend,
	type SeriesPoint,
	trendOf,
} from "./trend.ts";

const DAY = 24 * 60 * 60 * 1000;
const T = Date.parse("2026-08-11T00:00:00Z");

/** A point `daysAgo` before the anchor, so a fixture reads as its position in the window. */
const point = (daysAgo: number, passRate: number): SeriesPoint => ({
	fileName: `${new Date(T - daysAgo * DAY).toISOString().slice(0, 10)}.json`,
	recordedAt: new Date(T - daysAgo * DAY).toISOString(),
	passRate,
	sourceSha: "03135b91",
});

/** Three points in each half, spread so neither half is a single instant. */
const halves = (
	older: readonly [number, number, number],
	newer: readonly [number, number, number],
): ReadonlyArray<SeriesPoint> => [
	point(13, older[0]),
	point(11, older[1]),
	point(9, older[2]),
	point(5, newer[0]),
	point(3, newer[1]),
	point(0, newer[2]),
];

describe("trendOf — ADR 0252 §3's worked table", () => {
	it("flags a declining series: the half-means drop and the halves do not overlap", () => {
		const result = trendOf(halves([0.98, 0.97, 0.96], [0.9, 0.89, 0.88]));
		expect(result.answer).toBe("declining");
		expect(result.separated).toBe(true);
		expect(result.meanDrop).toBeGreaterThan(DECLINE_THRESHOLD);
	});

	it("does not flag a flat series", () => {
		const result = trendOf(halves([0.95, 0.94, 0.96], [0.95, 0.94, 0.96]));
		expect(result.answer).toBe("steady");
		expect(result.meanDrop).toBe(0);
	});

	it("does not flag a noisy series whose halves overlap — scatter, not drift", () => {
		const result = trendOf(halves([0.99, 0.85, 0.98], [0.99, 0.8, 0.83]));
		expect(result.answer).toBe("steady");
		expect(result.meanDrop).toBeGreaterThan(DECLINE_THRESHOLD);
		expect(result.separated).toBe(false);
	});

	it("does not flag a drop of exactly five points — both clauses are strict", () => {
		const result = trendOf(halves([0.95, 0.95, 0.95], [0.9, 0.9, 0.9]));
		expect(result.meanDrop).toBe(DECLINE_THRESHOLD);
		expect(result.separated).toBe(true);
		expect(result.answer).toBe("steady");
	});

	it("answers insufficient-data below the minimum sample, and never steady", () => {
		const result = trendOf([
			point(13, 0.98),
			point(11, 0.97),
			point(9, 0.96),
			point(3, 0.8),
			point(0, 0.79),
		]);
		expect(result.answer).toBe("insufficient-data");
		expect(result.newerCount).toBeLessThan(MINIMUM_HALF_POINTS);
		expect(result.meanDrop).toBeNull();
	});

	it("answers insufficient-data over an empty series rather than anchoring on nothing", () => {
		const result = trendOf([]);
		expect(result.answer).toBe("insufficient-data");
		expect(result.window).toBeNull();
	});

	it("anchors the window on the newest point, not on wall-clock now", () => {
		// Every point sits a year in the past; anchored on now, all six would fall outside the window
		// and the answer would drift with the clock. Anchored on the newest point, it is reproducible.
		const shifted = halves([0.98, 0.97, 0.96], [0.9, 0.89, 0.88]).map((p) => ({
			...p,
			recordedAt: new Date(Date.parse(p.recordedAt) - 365 * DAY).toISOString(),
		}));
		expect(trendOf(shifted).answer).toBe("declining");
	});

	it("ignores a point older than the window", () => {
		const result = trendOf([point(40, 0.2), ...halves([0.95, 0.95, 0.95], [0.9, 0.9, 0.9])]);
		expect(result.olderCount).toBe(3);
		expect(result.answer).toBe("steady");
	});
});

const scorecardOf = (args: {
	readonly recordedAt: string;
	readonly cells: ReadonlyArray<{
		readonly stage: string;
		readonly surface: string | null;
		readonly model: string;
		readonly passRate: number;
		readonly outcome?: "RECORDED" | "UNRECORDABLE";
	}>;
}): CommittedScorecard => ({
	recordedAt: args.recordedAt,
	decisionRef: 1576,
	framing: "measurement, not a recommendation",
	baseline: null,
	cells: args.cells.map((cell) => ({
		stage: cell.stage,
		surface: cell.surface,
		model: cell.model,
		pins: {model: cell.model, cli: "2.1.220", harness: "0.1.0"},
		source: {sha: "03135b91", recordedAt: args.recordedAt},
		outcome: cell.outcome ?? "RECORDED",
		gradedRuns: 2,
		passedRuns: 1,
		unmeasuredCases: 0,
		passRate: cell.passRate,
		cases: [
			{caseId: 1, verdict: "pass", dispersion: 0},
			{caseId: 2, verdict: "fail", dispersion: 0},
		],
	})),
});

describe("buildSeries", () => {
	it("keeps one series per cell — a pass rate measures one grading regime", () => {
		const series = buildSeries([
			{
				fileName: "2026-08-01.json",
				scorecard: scorecardOf({
					recordedAt: "2026-08-01T00:00:00Z",
					cells: [
						{stage: "review", surface: "skill", model: "opus-4.8", passRate: 0.9},
						{stage: "review", surface: "code", model: "opus-4.8", passRate: 0.5},
					],
				}),
			},
		]);
		expect(series).toHaveLength(2);
		expect(series.map((entry) => entry.points[0]?.passRate).sort()).toEqual([0.5, 0.9]);
	});

	it("gives an UNRECORDABLE cell no point rather than scoring it zero", () => {
		const series = buildSeries([
			{
				fileName: "2026-08-01.json",
				scorecard: scorecardOf({
					recordedAt: "2026-08-01T00:00:00Z",
					cells: [
						{
							stage: "review",
							surface: "skill",
							model: "opus-4.8",
							passRate: 0,
							outcome: "UNRECORDABLE",
						},
					],
				}),
			},
		]);
		expect(series).toHaveLength(0);
	});

	it("orders points by recordedAt, ties by file name ascending", () => {
		const cells = [{stage: "build", surface: null, model: "opus-4.8", passRate: 0.9}];
		const series = buildSeries([
			{fileName: "b.json", scorecard: scorecardOf({recordedAt: "2026-08-02T00:00:00Z", cells})},
			{fileName: "a.json", scorecard: scorecardOf({recordedAt: "2026-08-02T00:00:00Z", cells})},
			{fileName: "c.json", scorecard: scorecardOf({recordedAt: "2026-08-01T00:00:00Z", cells})},
		]);
		expect(series[0]?.points.map((p) => p.fileName)).toEqual(["c.json", "a.json", "b.json"]);
	});
});

describe("the co-gate reports and gates nothing", () => {
	it("names the answer, the cell and the window it read", () => {
		const cells = [{stage: "build", surface: null, model: "opus-4.8", passRate: 0.9}];
		const rendered = renderTrend(
			readTrend([
				{fileName: "a.json", scorecard: scorecardOf({recordedAt: "2026-08-01T00:00:00Z", cells})},
			]),
		);
		expect(rendered).toContain("observe-only");
		expect(rendered).toContain("trend: insufficient-data");
		expect(rendered).toContain("build");
	});

	it("reports insufficient-data over an empty series rather than a green", () => {
		expect(renderTrend(readTrend([]))).toContain("insufficient-data");
	});
});
