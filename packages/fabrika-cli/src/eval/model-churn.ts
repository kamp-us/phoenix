/**
 * The model-churn re-run contract — adjudicate a new model on numbers, not vibes (#4680).
 *
 * A new model is re-run over the same eval set, its record is committed as a scorecard, and that
 * scorecard is diffed against the **pinned series** for the same cells under every other model already
 * measured there. This module is the diff. It states deltas and **makes no recommendation** — the same
 * framing `report.ts` carries for the tiering decision, for the same reason: the harness supplies
 * evidence and the founder decides.
 *
 * **The comparison is only as good as its denominators.** Two cells whose graded-case counts differ are
 * not comparable on rate alone — a thinner sample can clear a bar the fuller one would not — so a row
 * whose case counts disagree is marked `comparable: false` and says why, rather than publishing a
 * delta that reads as settled ([#5407](https://github.com/kamp-us/phoenix/issues/5407) is the same
 * gap on the cost side).
 *
 * No bar and no threshold: whether a delta is acceptable is the founder's call, and whether a rate
 * clears 90% is #4681's.
 */
import {canonicalModel} from "../models.ts";
import {type CommittedCell, type CommittedScorecard, cellLabel} from "./committed-scorecard.ts";

export const CHURN_FRAMING =
	"This comparison states the deltas between a named model's re-run and the pinned scorecard series; " +
	"selecting a model is the founder's call over this evidence, and nothing here recommends one.";

/** One side of a comparison — a measured cell, with the file and head it came from. */
export interface ChurnSide {
	readonly model: string;
	readonly passRate: number;
	readonly gradedRuns: number;
	readonly unmeasuredCases: number;
	readonly recordedAt: string;
	readonly sourceSha: string;
	/** The committed file the number was read from; `null` for the candidate, which is not committed yet. */
	readonly fileName: string | null;
}

export interface ChurnDelta {
	readonly stage: string;
	readonly surface: string | null;
	readonly candidate: ChurnSide;
	readonly incumbent: ChurnSide;
	readonly passRateDelta: number;
	readonly gradedRunsDelta: number;
	readonly comparable: boolean;
	readonly caveat: string | null;
}

/** A candidate cell the series has never measured under any other model — a delta with no other side. */
export interface ChurnUnmatched {
	readonly stage: string;
	readonly surface: string | null;
	readonly model: string;
	readonly reason: string;
}

export interface ChurnComparison {
	readonly model: string;
	readonly framing: string;
	readonly deltas: ReadonlyArray<ChurnDelta>;
	readonly unmatched: ReadonlyArray<ChurnUnmatched>;
}

const sideOf = (cell: CommittedCell, recordedAt: string, fileName: string | null): ChurnSide => ({
	model: cell.model,
	passRate: cell.passRate,
	gradedRuns: cell.gradedRuns,
	unmeasuredCases: cell.unmeasuredCases,
	recordedAt,
	sourceSha: cell.source.sha,
	fileName,
});

const regimeKey = (cell: {readonly stage: string; readonly surface: string | null}): string =>
	JSON.stringify([cell.stage, cell.surface]);

/**
 * Diff a named model's re-run against the pinned series.
 *
 * The incumbent for a cell is the **most recent** committed point for the same `(stage, surface)` under
 * a *different* model — one row per incumbent model, because a cell measured under two other models has
 * two honest comparisons and picking one of them would be this module making the call it refuses to
 * make. Only `RECORDED` cells take part on either side: an `UNRECORDABLE` run measured nothing, and a
 * delta against nothing is not a delta.
 */
export const compareToSeries = (args: {
	readonly model: string;
	readonly candidate: CommittedScorecard;
	readonly series: ReadonlyArray<{
		readonly fileName: string;
		readonly scorecard: CommittedScorecard;
	}>;
}): ChurnComparison => {
	const model = canonicalModel(args.model) ?? args.model;

	const latestIncumbent = new Map<string, {readonly regime: string; readonly side: ChurnSide}>();
	for (const file of args.series) {
		for (const cell of file.scorecard.cells) {
			if (cell.outcome !== "RECORDED" || cell.model === model) continue;
			const regime = regimeKey(cell);
			const key = JSON.stringify([regime, cell.model]);
			const existing = latestIncumbent.get(key);
			if (existing !== undefined && existing.side.recordedAt >= file.scorecard.recordedAt) continue;
			latestIncumbent.set(key, {
				regime,
				side: sideOf(cell, file.scorecard.recordedAt, file.fileName),
			});
		}
	}

	const deltas: Array<ChurnDelta> = [];
	const unmatched: Array<ChurnUnmatched> = [];
	for (const cell of args.candidate.cells) {
		if (cell.model !== model) continue;
		if (cell.outcome !== "RECORDED") {
			unmatched.push({
				stage: cell.stage,
				surface: cell.surface,
				model: cell.model,
				reason: "the re-run recorded no measurement for this cell (UNRECORDABLE)",
			});
			continue;
		}
		const candidate = sideOf(cell, args.candidate.recordedAt, null);
		const regime = regimeKey(cell);
		const incumbents = [...latestIncumbent.values()].filter((entry) => entry.regime === regime);
		if (incumbents.length === 0) {
			unmatched.push({
				stage: cell.stage,
				surface: cell.surface,
				model: cell.model,
				reason: "the series carries no committed point for this cell under any other model",
			});
			continue;
		}
		for (const incumbent of incumbents) {
			const comparable = incumbent.side.gradedRuns === candidate.gradedRuns;
			deltas.push({
				stage: cell.stage,
				surface: cell.surface,
				candidate,
				incumbent: incumbent.side,
				passRateDelta: candidate.passRate - incumbent.side.passRate,
				gradedRunsDelta: candidate.gradedRuns - incumbent.side.gradedRuns,
				comparable,
				caveat: comparable
					? null
					: `the two sides graded a different number of cases (${candidate.gradedRuns} vs ${incumbent.side.gradedRuns}) — the rate delta is not a like-for-like comparison`,
			});
		}
	}

	return {model, framing: CHURN_FRAMING, deltas, unmatched};
};

const signed = (value: number): string => {
	const rounded = Math.round(value * 10_000) / 10_000;
	return rounded > 0 ? `+${rounded}` : String(rounded);
};

/** The human table. Every row states a delta; no row states a verdict. */
export const renderChurn = (comparison: ChurnComparison): string => {
	const lines: Array<string> = [
		`fabrika model-churn re-run — candidate ${comparison.model} vs the pinned scorecard series`,
		comparison.framing,
		"",
	];
	const header = [
		"stage",
		"surface",
		"incumbent",
		"incumbent rate",
		"candidate rate",
		"Δ rate",
		"Δ graded cases",
		"",
	];
	const rows = comparison.deltas.map((delta) => [
		delta.stage,
		delta.surface ?? "—",
		delta.incumbent.model,
		`${delta.incumbent.passRate} (${delta.incumbent.gradedRuns})`,
		`${delta.candidate.passRate} (${delta.candidate.gradedRuns})`,
		signed(delta.passRateDelta),
		signed(delta.gradedRunsDelta),
		delta.comparable ? "" : "NOT LIKE-FOR-LIKE",
	]);
	if (rows.length === 0) {
		lines.push(
			"no cell of the re-run has a committed point under another model to compare against.",
		);
	} else {
		const widths = header.map((h, i) =>
			Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
		);
		const fmt = (cols: ReadonlyArray<string>): string =>
			cols
				.map((c, i) => c.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd();
		lines.push(fmt(header));
		lines.push(
			widths
				.map((w) => "-".repeat(w))
				.join("  ")
				.trimEnd(),
		);
		for (const row of rows) lines.push(fmt(row));
	}
	for (const delta of comparison.deltas) {
		if (delta.caveat !== null) {
			lines.push(`  caveat — ${delta.stage}/${delta.surface ?? "—"}: ${delta.caveat}`);
		}
	}
	for (const item of comparison.unmatched) {
		lines.push(
			`  no comparison — ${cellLabel({stage: item.stage, surface: item.surface, model: item.model})}: ${item.reason}`,
		);
	}
	return lines.join("\n");
};

export const churnToJson = (comparison: ChurnComparison): string =>
	`${JSON.stringify(comparison, null, 2)}\n`;
