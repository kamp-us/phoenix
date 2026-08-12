/**
 * The committed scorecard — one dated file per eval run, and the series the trend reads (#4680).
 *
 *     claude-plugins/fabrika/reports/eval/2026-08-11.json
 *
 * A scorecard is a **digest of head-bound eval records** (`../wire/eval-record.ts`), never a fresh
 * measurement: the graded numbers are produced by the review stage and this module only commits them
 * (founder ruling on #4649, comment 5153280445). So every cell cites the record it came from — the
 * head SHA that record was bound to — and a cell citing none is refused on the same footing as one
 * missing a pin.
 *
 * Three refusals, and they are the artifact's precondition rather than a lint pass over it:
 *
 * - **A missing pin.** #4637 ruling 4 pins every scorecard to model + CLI + harness. A scorecard that
 *   cannot say what it was measured on cannot be compared to the next one, so a blank pin is rejected
 *   rather than committed.
 * - **An unsourced cell.** A number with no record behind it is a number nobody can check back to a
 *   tree — the same reason the record re-derives its own aggregates instead of trusting them.
 * - **An aggregate that disagrees with its own cases.** Every cell carries its case list, so
 *   `gradedRuns` / `passedRuns` / `unmeasuredCases` / `passRate` are re-derived on read. `gradedRuns`
 *   counts **cases**, not invocations (founder ruling, #5258): the five executions behind a case
 *   collapse into one median verdict before they reach a scorecard.
 *
 * `unmeasuredCases` is carried rather than implied because it is the one fact the rate cannot express:
 * a run that graded three of four cases reports `3/3 = 1.0`, and without the field the row hides the
 * case that never ran — the "0.0 over no measurement" figure ADR 0253 §2 exists to keep visible. The
 * same reason keeps `outcome` on the cell: an `UNRECORDABLE` run is **broken**, and broken must stay
 * distinguishable from absent.
 *
 * The body is a superset of `report.ts`'s stable `Scorecard` JSON — same `decisionRef` / `framing` /
 * `baseline` / `cells` keys, same `stage` / `surface` / `model` / `gradedRuns` / `passedRuns` /
 * `passRate` spellings inside a cell — so the #4765 ruling that a committed file's cells read with the
 * existing reader still holds, and the pins #4637 requires ride as added fields (the reconciliation
 * that ruling left to this issue).
 *
 * No bar appears here. Whether a rate clears 90% is #4681's judgement.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";
import type {CaseVerdict, EvalRecord} from "../wire/eval-record.ts";
import {roundRate} from "../wire/eval-record.ts";
import {DECISION_FRAMING, DECISION_POINTER} from "./report.ts";

/** Where the series lives — the founder's #4765 ruling, repo-relative. */
export const SERIES_DIR = "claude-plugins/fabrika/reports/eval";

/** One graded case as the committed row keeps it: the median verdict and what the median threw away. */
export interface CommittedCase {
	readonly caseId: number;
	readonly verdict: CaseVerdict;
	/** The minority-verdict count of the case's five runs (ADR 0252 §1) — recorded, never gating. */
	readonly dispersion: number;
}

/** #4637 ruling 4's triple. A blank member is a rejection, never a defaulted string. */
export interface ScorecardPins {
	readonly model: string;
	readonly cli: string;
	readonly harness: string;
}

/** The eval record a cell was sourced from — the checkable provenance of its number. */
export interface CellSource {
	/** The head the record was bound to, so the measurement points at a tree. */
	readonly sha: string;
	readonly recordedAt: string;
}

/** One `(stage × surface × model)` cell of a committed scorecard. */
export interface CommittedCell {
	readonly stage: string;
	readonly surface: string | null;
	readonly model: string;
	readonly pins: ScorecardPins;
	readonly source: CellSource;
	readonly outcome: "RECORDED" | "UNRECORDABLE";
	readonly gradedRuns: number;
	readonly passedRuns: number;
	readonly unmeasuredCases: number;
	readonly passRate: number;
	readonly cases: ReadonlyArray<CommittedCase>;
}

export interface CommittedScorecard {
	/** The ordering key of the series (ADR 0252 §3 names this spelling). */
	readonly recordedAt: string;
	readonly decisionRef: number;
	readonly framing: string;
	/** Always `null`: a graded scorecard names no spend baseline. Kept so the ruled shape decodes. */
	readonly baseline: null;
	readonly cells: ReadonlyArray<CommittedCell>;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The `(stage, surface, model)` key, for `report.ts`'s reason: no stage, surface or model value may
 * spell a neighbouring key and merge two cells. JSON quoting is what makes that true without picking
 * a separator character and hoping no value carries it.
 */
export const cellKeyOf = (cell: {
	readonly stage: string;
	readonly surface: string | null;
	readonly model: string;
}): string => JSON.stringify([cell.stage, cell.surface, cell.model]);

/** The human spelling of a cell key, for a message a person reads. */
export const cellLabel = (cell: {
	readonly stage: string;
	readonly surface: string | null;
	readonly model: string;
}): string => `${cell.stage}/${cell.surface ?? "—"} × ${cell.model}`;

export type ScorecardRejection =
	| "zero-scope"
	| "missing-pin"
	| "unsourced-cell"
	| "duplicate-cell"
	| "inconsistent-aggregate"
	| "bad-timestamp";

export type ScorecardBuild =
	| {readonly _tag: "Scorecard"; readonly scorecard: CommittedScorecard}
	| {readonly _tag: "Rejected"; readonly rejection: ScorecardRejection; readonly reason: string};

const reject = (rejection: ScorecardRejection, reason: string): ScorecardBuild => ({
	_tag: "Rejected",
	rejection,
	reason,
});

const blankPin = (pins: ScorecardPins): string | null => {
	if (pins.model.trim() === "") return "model";
	if (pins.cli.trim() === "") return "cli";
	if (pins.harness.trim() === "") return "harness";
	return null;
};

const cellOf = (record: EvalRecord): CommittedCell => ({
	stage: record.payload.cell.stage,
	surface: record.payload.cell.surface,
	model: record.payload.cell.model,
	pins: record.payload.pins,
	source: {sha: record.payload.sha, recordedAt: record.payload.recordedAt},
	outcome: record.outcome,
	gradedRuns: record.payload.gradedRuns,
	passedRuns: record.payload.passedRuns,
	unmeasuredCases: record.payload.unmeasuredCases,
	passRate: record.payload.passRate,
	cases: record.payload.cases.map((block) => ({
		caseId: block.caseId,
		verdict: block.verdict,
		dispersion: block.dispersion,
	})),
});

/**
 * Build a committed scorecard from the records one run produced.
 *
 * The records arrive already validated by `read` (`../wire/eval-record.ts`), which re-derives every
 * aggregate it carries — so this does not re-check arithmetic it inherits. What it does check is what
 * only the *file* can get wrong: that there is something to commit, that the pins are complete, and
 * that no two records claim the same cell, which would put two points of one series in one file and
 * make "the scorecard's pass rate for a cell" ambiguous.
 */
export const buildCommittedScorecard = (args: {
	readonly recordedAt: string;
	readonly records: ReadonlyArray<EvalRecord>;
}): ScorecardBuild => {
	if (!ISO_UTC.test(args.recordedAt.trim())) {
		return reject(
			"bad-timestamp",
			`"${args.recordedAt}" is not an ISO-8601 UTC instant with a trailing Z — the series is ordered on this field`,
		);
	}
	// A scorecard over no record is the vacuous green ADR 0092 forbids: it would commit a point that
	// says a run happened and carries nothing measured.
	if (args.records.length === 0) {
		return reject(
			"zero-scope",
			"no eval record was given — a scorecard over nothing measures nothing",
		);
	}

	const cells: Array<CommittedCell> = [];
	const seen = new Set<string>();
	for (const record of args.records) {
		const cell = cellOf(record);
		const missing = blankPin(cell.pins);
		if (missing !== null) {
			return reject(
				"missing-pin",
				`the record for ${cellLabel(cell)} names no ${missing} pin — a scorecard that cannot say what it was measured on is not comparable to the next one (#4637 ruling 4)`,
			);
		}
		const key = cellKeyOf(cell);
		if (seen.has(key)) {
			return reject(
				"duplicate-cell",
				`two records claim ${cellLabel(cell)} — one scorecard carries at most one point per cell`,
			);
		}
		seen.add(key);
		cells.push(cell);
	}

	return {
		_tag: "Scorecard",
		scorecard: {
			recordedAt: args.recordedAt.trim(),
			decisionRef: DECISION_POINTER,
			framing: DECISION_FRAMING,
			baseline: null,
			cells,
		},
	};
};

/**
 * The committed bytes. One trailing newline, so the file is a well-formed text file.
 *
 * Tab-indented for the reason `cost-baseline.ts`'s `costBaselineToJson` states: this output is
 * *committed*, so it is written the way biome formats committed JSON.
 */
export const toJson = (scorecard: CommittedScorecard): string =>
	`${JSON.stringify(scorecard, null, "\t")}\n`;

const CaseSchema = Schema.Struct({
	caseId: Schema.Int,
	verdict: Schema.Literals(["pass", "fail", "unmeasured"]),
	dispersion: Schema.Int,
});

const PinsSchema = Schema.Struct({
	model: Schema.String,
	cli: Schema.String,
	harness: Schema.String,
});

const SourceSchema = Schema.Struct({sha: Schema.String, recordedAt: Schema.String});

const CellSchema = Schema.Struct({
	stage: Schema.String,
	surface: Schema.NullOr(Schema.String),
	model: Schema.String,
	pins: PinsSchema,
	source: SourceSchema,
	outcome: Schema.Literals(["RECORDED", "UNRECORDABLE"]),
	gradedRuns: Schema.Int,
	passedRuns: Schema.Int,
	unmeasuredCases: Schema.Int,
	passRate: Schema.Finite,
	cases: Schema.Array(CaseSchema),
});

const CommittedScorecardSchema = Schema.Struct({
	recordedAt: Schema.String,
	decisionRef: Schema.Int,
	framing: Schema.String,
	baseline: Schema.Null,
	cells: Schema.Array(CellSchema),
});

/** A committed file that could not be read as a point of the series. */
export class CommittedScorecardError extends Schema.TaggedErrorClass<CommittedScorecardError>()(
	"CommittedScorecardError",
	{
		reason: Schema.Literals([
			"malformed-json",
			"schema-mismatch",
			"zero-scope",
			"missing-pin",
			"unsourced-cell",
			"duplicate-cell",
			"inconsistent-aggregate",
			"bad-timestamp",
		]),
		message: Schema.String,
	},
) {}

const decodeUnknown = Schema.decodeUnknownResult(CommittedScorecardSchema);

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Re-derive a cell's aggregate from its own case list.
 *
 * The record refuses a payload whose stored counts contradict its case blocks, and a committed file is
 * a second copy of those numbers that a hand edit can desynchronize — so the same check runs again
 * here, on the artifact a reader actually consumes. Returning the disagreement rather than repairing
 * it is deliberate: a silently corrected file would publish a number nobody measured.
 */
const aggregateDisagreement = (cell: CommittedCell): string | null => {
	const graded = cell.cases.filter((block) => block.verdict !== "unmeasured");
	const passed = graded.filter((block) => block.verdict === "pass").length;
	const unmeasured = cell.cases.length - graded.length;
	if (cell.gradedRuns !== graded.length) {
		return `gradedRuns is ${cell.gradedRuns}; the case list carries ${graded.length} graded case(s)`;
	}
	if (cell.passedRuns !== passed) {
		return `passedRuns is ${cell.passedRuns}; the case list carries ${passed} passing case(s)`;
	}
	if (cell.unmeasuredCases !== unmeasured) {
		return `unmeasuredCases is ${cell.unmeasuredCases}; the case list carries ${unmeasured}`;
	}
	const derived = graded.length === 0 ? 0 : roundRate(passed / graded.length);
	if (roundRate(cell.passRate) !== derived) {
		return `passRate is ${cell.passRate}; ${passed}/${graded.length} is ${derived}`;
	}
	// The token and the denominator are one fact, exactly as they are on the record: RECORDED over an
	// empty denominator is a measurement nobody took, and UNRECORDABLE over a real one hides one taken.
	if (cell.outcome === "RECORDED" && graded.length === 0) {
		return "a RECORDED cell over zero graded cases measures nothing";
	}
	if (cell.outcome === "UNRECORDABLE" && graded.length > 0) {
		return `an UNRECORDABLE cell reports ${graded.length} graded case(s) — that is a measurement`;
	}
	return null;
};

const fail = (
	reason: CommittedScorecardError["reason"],
	message: string,
): Result.Result<CommittedScorecard, CommittedScorecardError> =>
	Result.fail(new CommittedScorecardError({reason, message}));

/**
 * Read a committed scorecard back. Total — every rejection is a typed failure, never a throw.
 *
 * The pin and source checks are the read-side half of the artifact's precondition: a file that reached
 * the repo past `build` (a hand edit, a merge, an older writer) is refused here rather than counted as
 * a point of the series.
 */
export const decodeCommittedScorecard = (
	text: string,
): Result.Result<CommittedScorecard, CommittedScorecardError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new CommittedScorecardError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknown(parsed).pipe(
				Result.mapError(
					(error) =>
						new CommittedScorecardError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
		Result.flatMap((scorecard) => {
			if (!ISO_UTC.test(scorecard.recordedAt)) {
				return fail(
					"bad-timestamp",
					`recordedAt "${scorecard.recordedAt}" is not an ISO-8601 UTC instant with a trailing Z`,
				);
			}
			if (scorecard.cells.length === 0) {
				return fail("zero-scope", "the scorecard carries no cell — it commits no measurement");
			}
			const seen = new Set<string>();
			for (const cell of scorecard.cells) {
				const missing = blankPin(cell.pins);
				if (missing !== null) {
					return fail("missing-pin", `${cellLabel(cell)} names no ${missing} pin (#4637 ruling 4)`);
				}
				if (!HEX_SHA.test(cell.source.sha) || !ISO_UTC.test(cell.source.recordedAt)) {
					return fail(
						"unsourced-cell",
						`${cellLabel(cell)} cites no head-bound eval record — an unsourced number is not a point of the series`,
					);
				}
				const key = cellKeyOf(cell);
				if (seen.has(key)) {
					return fail("duplicate-cell", `two cells claim ${cellLabel(cell)}`);
				}
				seen.add(key);
				const disagreement = aggregateDisagreement(cell);
				if (disagreement !== null) {
					return fail("inconsistent-aggregate", `${cellLabel(cell)}: ${disagreement}`);
				}
			}
			return Result.succeed(scorecard);
		}),
	);

/**
 * A series member's file name: the run's UTC date, optionally with the same-date counter below.
 *
 * This is the *membership rule* of the series, and it is the exact inverse of {@link seriesFileName} —
 * the writer's name generator and the reader's admission test are one fact stated twice, which
 * `committed-scorecard.unit.test.ts` re-derives rather than asserts. That inverse is what makes the
 * directory shareable: `claude-plugins/fabrika/reports/eval/` also holds the dated **cost baselines**
 * (`baseline-v1-<date>.json`, #4679), and any later dated artifact of the eval layer will land there
 * too. Selecting members by `*.json` made every one of those a malformed scorecard and took the
 * series down; selecting them by the name the series' own writer produces cannot.
 *
 * A name that matches and does not decode is still a hard refusal — that is a corrupt *member*, not a
 * neighbour, and silently skipping it would drop a measurement from the trend.
 */
const SERIES_FILE_NAME = /^\d{4}-\d{2}-\d{2}(?:-\d+)?\.json$/;

/** Whether a file name in the series directory names a point of the series. */
export const isSeriesFileName = (fileName: string): boolean => SERIES_FILE_NAME.test(fileName);

/**
 * The file name for a scorecard, and what a second run on the same date does to it (#4765 left this
 * to this issue).
 *
 * The name is the run's UTC date, so a lexicographic listing of the directory is a chronological
 * listing of the series. A second run that day takes `-2`, `-3` … rather than overwriting: a committed
 * point is never mutated, the same append-only discipline the corpus is governed by.
 */
export const seriesFileName = (recordedAt: string, taken: ReadonlyArray<string>): string => {
	const date = recordedAt.slice(0, 10);
	const used = new Set(taken);
	if (!used.has(`${date}.json`)) return `${date}.json`;
	for (let n = 2; ; n += 1) {
		const candidate = `${date}-${n}.json`;
		if (!used.has(candidate)) return candidate;
	}
};

/** The human summary of a scorecard about to be committed — what it measured, on what. */
export const renderCommittedScorecard = (scorecard: CommittedScorecard): string => {
	const lines: Array<string> = [
		`fabrika committed scorecard — recordedAt ${scorecard.recordedAt}`,
		scorecard.framing,
		"",
	];
	const header = ["stage", "surface", "model", "rate", "unmeasured", "source", "cli", "harness"];
	const rows = scorecard.cells.map((cell) => [
		cell.stage,
		cell.surface ?? "—",
		cell.model,
		cell.outcome === "UNRECORDABLE"
			? "no measurement"
			: `${cell.passRate} (${cell.passedRuns}/${cell.gradedRuns} cases)`,
		String(cell.unmeasuredCases),
		cell.source.sha,
		cell.pins.cli,
		cell.pins.harness,
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
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
	return lines.join("\n");
};
