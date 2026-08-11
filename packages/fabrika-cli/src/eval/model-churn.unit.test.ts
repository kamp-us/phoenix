/**
 * The model-churn comparison's own tier.
 *
 * Two properties carry the design: the output states deltas and names no winner, and a comparison
 * whose two sides graded different numbers of cases says so instead of publishing a rate delta that
 * reads as settled.
 */
import {describe, expect, it} from "vitest";
import type {CommittedScorecard} from "./committed-scorecard.ts";
import {churnToJson, compareToSeries, renderChurn} from "./model-churn.ts";

const scorecardOf = (args: {
	readonly recordedAt: string;
	readonly cells: ReadonlyArray<{
		readonly stage: string;
		readonly surface: string | null;
		readonly model: string;
		readonly passRate: number;
		readonly gradedRuns?: number;
		readonly outcome?: "RECORDED" | "UNRECORDABLE";
	}>;
}): CommittedScorecard => ({
	recordedAt: args.recordedAt,
	decisionRef: 1576,
	framing: "measurement, not a recommendation",
	baseline: null,
	cells: args.cells.map((cell) => {
		const graded = cell.gradedRuns ?? 4;
		return {
			stage: cell.stage,
			surface: cell.surface,
			model: cell.model,
			pins: {model: cell.model, cli: "2.1.220", harness: "0.1.0"},
			source: {sha: "03135b91", recordedAt: args.recordedAt},
			outcome: cell.outcome ?? "RECORDED",
			gradedRuns: graded,
			passedRuns: Math.round(cell.passRate * graded),
			unmeasuredCases: 0,
			passRate: cell.passRate,
			cases: [],
		};
	}),
});

const candidate = scorecardOf({
	recordedAt: "2026-08-11T00:00:00Z",
	cells: [{stage: "review", surface: "skill", model: "sonnet-4.8", passRate: 0.75}],
});

const series = [
	{
		fileName: "2026-08-01.json",
		scorecard: scorecardOf({
			recordedAt: "2026-08-01T00:00:00Z",
			cells: [{stage: "review", surface: "skill", model: "opus-4.8", passRate: 0.5}],
		}),
	},
	{
		fileName: "2026-08-05.json",
		scorecard: scorecardOf({
			recordedAt: "2026-08-05T00:00:00Z",
			cells: [{stage: "review", surface: "skill", model: "opus-4.8", passRate: 0.95}],
		}),
	},
];

describe("compareToSeries", () => {
	it("states the delta against the most recent committed point for the cell", () => {
		const comparison = compareToSeries({model: "sonnet-4.8", candidate, series});
		expect(comparison.deltas).toHaveLength(1);
		const delta = comparison.deltas[0];
		expect(delta?.incumbent.model).toBe("opus-4.8");
		expect(delta?.incumbent.recordedAt).toBe("2026-08-05T00:00:00Z");
		expect(delta?.passRateDelta).toBeCloseTo(-0.2, 10);
		expect(delta?.comparable).toBe(true);
	});

	it("compares against every other model measured on the cell, picking none of them", () => {
		const comparison = compareToSeries({
			model: "sonnet-4.8",
			candidate,
			series: [
				...series,
				{
					fileName: "2026-08-06.json",
					scorecard: scorecardOf({
						recordedAt: "2026-08-06T00:00:00Z",
						cells: [{stage: "review", surface: "skill", model: "haiku-4.8", passRate: 0.6}],
					}),
				},
			],
		});
		expect(comparison.deltas.map((delta) => delta.incumbent.model).sort()).toEqual([
			"haiku-4.8",
			"opus-4.8",
		]);
	});

	it("marks a comparison whose sides graded different case counts as not like-for-like", () => {
		const comparison = compareToSeries({
			model: "sonnet-4.8",
			candidate: scorecardOf({
				recordedAt: "2026-08-11T00:00:00Z",
				cells: [
					{stage: "review", surface: "skill", model: "sonnet-4.8", passRate: 1, gradedRuns: 2},
				],
			}),
			series,
		});
		const delta = comparison.deltas[0];
		expect(delta?.comparable).toBe(false);
		expect(delta?.caveat).toContain("different number of cases");
		expect(renderChurn(comparison)).toContain("NOT LIKE-FOR-LIKE");
	});

	it("reports a cell the series has never measured under another model", () => {
		const comparison = compareToSeries({model: "sonnet-4.8", candidate, series: []});
		expect(comparison.deltas).toHaveLength(0);
		expect(comparison.unmatched[0]?.reason).toContain("no committed point");
	});

	it("does not compare a re-run that measured nothing", () => {
		const comparison = compareToSeries({
			model: "sonnet-4.8",
			candidate: scorecardOf({
				recordedAt: "2026-08-11T00:00:00Z",
				cells: [
					{
						stage: "review",
						surface: "skill",
						model: "sonnet-4.8",
						passRate: 0,
						outcome: "UNRECORDABLE",
					},
				],
			}),
			series,
		});
		expect(comparison.deltas).toHaveLength(0);
		expect(comparison.unmatched[0]?.reason).toContain("UNRECORDABLE");
	});

	it("makes no recommendation — the JSON has no winner, selection or threshold key", () => {
		const comparison = compareToSeries({model: "sonnet-4.8", candidate, series});
		const keys = new Set<string>();
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) return void value.forEach(walk);
			if (typeof value !== "object" || value === null) return;
			for (const [key, nested] of Object.entries(value)) {
				keys.add(key.toLowerCase());
				walk(nested);
			}
		};
		walk(JSON.parse(churnToJson(comparison)));
		for (const key of keys) {
			expect(key).not.toMatch(/recommend|winner|select|adopt|threshold|verdict/);
		}
		expect(renderChurn(comparison)).toContain("the founder's call");
	});
});
