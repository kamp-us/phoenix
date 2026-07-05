/**
 * eval-harness report core — the graded two-axis scorecard (issue #1853, epic #1842).
 *
 * The top of the eval-harness vertical slice and the evidence artifact the model-tiering
 * decision (#1576) consumes. It aggregates the runner's graded `{entry, grade, spend}` rows
 * (`runner.ts`) into a per-(stage × model) scorecard on the ADR 0112 §4 two-axis gate, now
 * GRADED: the token axis (billed + ex-cache-read spend per run, ADR 0112 §2) AND a graded
 * quality axis (pass-rate over the corpus) with its net-token churn price (`repair-churn.ts`).
 *
 * The headline risk the epic exists to surface: a (stage × model) whose per-run token saving
 * is EATEN by repair churn. Priced against a baseline (stage × model), such a cell reports a
 * NEGATIVE `netSaving` — the saving that does not survive the extra churn a lower pass-rate
 * forces — so the crossover the binary-per-run gate cannot see is legible at a glance.
 *
 * This is MEASUREMENT, not a recommendation. The report states pass-rate + net-token cost per
 * cell; it never selects or recommends a model. That call is #1576, a separate `type:decision`
 * — the harness supplies evidence, the human decides. `DECISION_POINTER` carries that framing
 * into both the human table and the JSON.
 *
 * Pure + total, matching the corpus/oracle/runner discipline: rows with no reconstructed spend
 * (a `TranscriptMissing` run) still COUNT toward the grade (pass-rate) and are reported as such
 * — a cell's spend is the mean over its reconstructed runs, and a cell with zero reconstructed
 * spends reports a null token axis rather than a fabricated zero.
 */
import {Data, Result} from "effect";
import * as Schema from "effect/Schema";
import {CorpusEntry} from "./corpus.ts";
import {priceModelSwap, repairChurnCost} from "./repair-churn.ts";
import type {RunRow} from "./runner.ts";

/** The issue the report's evidence feeds — the tiering DECISION, which this report never makes. */
export const DECISION_POINTER = 1576;

/** The one-line framing carried into every rendered surface: evidence, not a recommendation. */
export const DECISION_FRAMING =
	`This scorecard is measurement feeding the model-tiering decision (#${DECISION_POINTER}); ` +
	"it presents pass-rate + net-token cost and does not recommend or select a model.";

/** A per-run token spend, averaged over a cell's reconstructed runs. Null when none reconstructed. */
export interface CellSpend {
	/** Mean billed tokens per run (the four-`usage`-component sum, ADR 0112 §2). */
	readonly billedPerRun: number;
	/** Mean ex-cache-read tokens per run (the cross-run comparator, ADR 0112 §2). */
	readonly exCacheReadPerRun: number;
	/** How many of the cell's runs had a reconstructed transcript (the mean's denominator). */
	readonly reconstructedRuns: number;
	/** How many of the cell's runs had NO transcript (counted for grade, absent from the mean). */
	readonly transcriptMissingRuns: number;
}

/** The priced repair churn for a cell — the net-token price of a lower pass-rate. */
export interface CellChurn {
	readonly expectedExtraCycles: number;
	readonly churnTokens: number;
	readonly amortizedBilledPerRun: number;
}

/** One (stage × model) cell of the scorecard — the graded two-axis picture for that pair. */
export interface ScorecardCell {
	readonly stage: CorpusEntry["stage"];
	/** The model the runs used, reconstructed from the transcript; `null` when unattributable. */
	readonly model: string | null;
	/** Total graded runs in the cell (the pass-rate denominator; includes transcript-missing). */
	readonly gradedRuns: number;
	/** Runs that graded `pass`. */
	readonly passedRuns: number;
	/** `passedRuns / gradedRuns` — the graded quality axis (ADR 0112 §4). */
	readonly passRate: number;
	/** The token axis: mean billed + ex-cache-read spend per run. Null when no run reconstructed. */
	readonly spend: CellSpend | null;
	/**
	 * The priced repair churn: expected extra cycles × per-repair-cycle tokens, added to the
	 * per-run spend to get the amortized true cost of one accepted run. Null when there is no
	 * reconstructed spend to price against.
	 */
	readonly churn: CellChurn | null;
	/**
	 * The net saving of this cell against the scorecard's baseline cell, priced on
	 * churn-amortized tokens. Null on the baseline cell itself, and when either this cell or the
	 * baseline lacks a reconstructed spend. NEGATIVE ⇒ churn ate the saving — the epic's crossover.
	 */
	readonly netSaving: number | null;
	/** True iff `netSaving` is a real number below zero — the unambiguous net-negative flag. */
	readonly netNegative: boolean;
}

/** The whole scorecard: the framing pointer plus one cell per (stage × model). */
export interface Scorecard {
	/** The decision this evidence feeds (#1576) — the report never makes it. */
	readonly decisionRef: number;
	readonly framing: string;
	/** The (stage × model) chosen as the per-run baseline saving is measured against, if any. */
	readonly baseline: {readonly stage: string; readonly model: string | null} | null;
	readonly cells: ReadonlyArray<ScorecardCell>;
}

/** Which (stage × model) to price the other cells' net saving against. */
export interface BaselineKey {
	readonly stage: CorpusEntry["stage"];
	readonly model: string | null;
}

const cellKey = (stage: string, model: string | null): string => `${stage} ${model ?? ""}`;

interface Bucket {
	readonly stage: CorpusEntry["stage"];
	readonly model: string | null;
	graded: number;
	passed: number;
	billedSum: number;
	exCacheReadSum: number;
	reconstructed: number;
	transcriptMissing: number;
}

const bucketize = (rows: ReadonlyArray<RunRow>): ReadonlyArray<Bucket> => {
	const byKey = new Map<string, Bucket>();
	for (const row of rows) {
		const model = row.spend._tag === "Reconstructed" ? row.spend.spend.model : null;
		const key = cellKey(row.entry.stage, model);
		let bucket = byKey.get(key);
		if (bucket === undefined) {
			bucket = {
				stage: row.entry.stage,
				model,
				graded: 0,
				passed: 0,
				billedSum: 0,
				exCacheReadSum: 0,
				reconstructed: 0,
				transcriptMissing: 0,
			};
			byKey.set(key, bucket);
		}
		bucket.graded += 1;
		if (row.grade.status === "pass") bucket.passed += 1;
		if (row.spend._tag === "Reconstructed") {
			bucket.reconstructed += 1;
			bucket.billedSum += row.spend.spend.billed;
			bucket.exCacheReadSum += row.spend.spend.exCacheRead;
		} else {
			bucket.transcriptMissing += 1;
		}
	}
	return [...byKey.values()];
};

const spendOf = (bucket: Bucket): CellSpend | null =>
	bucket.reconstructed === 0
		? null
		: {
				billedPerRun: bucket.billedSum / bucket.reconstructed,
				exCacheReadPerRun: bucket.exCacheReadSum / bucket.reconstructed,
				reconstructedRuns: bucket.reconstructed,
				transcriptMissingRuns: bucket.transcriptMissing,
			};

/**
 * Aggregate the runner's graded rows into the two-axis scorecard. Rows are bucketed by
 * (stage × reconstructed model); each cell gets its pass-rate, its mean per-run spend, its
 * priced repair churn, and — when a `baseline` cell is named and both have a reconstructed
 * spend — its net saving against that baseline. Pure + total: a cell with no reconstructed
 * spend reports a null token axis / churn / net saving rather than fabricating a zero, and
 * `passRate = 0` prices `+Infinity` churn (never adopt), the honest geometric limit.
 *
 * `tokensPerRepairCycle` defaults to the cell's own per-run billed spend — a repair cycle is
 * another run of the same stage — matching `repair-churn.ts`'s model; a caller with a measured
 * per-repair figure may override it.
 */
export const buildScorecard = (args: {
	readonly rows: ReadonlyArray<RunRow>;
	readonly baseline?: BaselineKey;
	readonly tokensPerRepairCycle?: (cell: {stage: string; model: string | null}) => number;
}): Scorecard => {
	const buckets = bucketize(args.rows);
	const baseline = args.baseline;
	const baselineBucket =
		baseline === undefined
			? undefined
			: buckets.find((b) => b.stage === baseline.stage && b.model === (baseline.model ?? null));
	const baselineSpend = baselineBucket !== undefined ? spendOf(baselineBucket) : null;

	const cells = buckets.map((bucket): ScorecardCell => {
		const passRate = bucket.graded === 0 ? 0 : bucket.passed / bucket.graded;
		const spend = spendOf(bucket);

		let churn: CellChurn | null = null;
		let netSaving: number | null = null;
		let netNegative = false;

		if (spend !== null) {
			const repairCycle =
				args.tokensPerRepairCycle?.({stage: bucket.stage, model: bucket.model}) ??
				spend.billedPerRun;
			const priced = repairChurnCost({
				passRate,
				tokensPerRun: spend.billedPerRun,
				tokensPerRepairCycle: repairCycle,
			});
			// Inputs are already domain-valid (passRate ∈ [0,1], non-negative means), so this decode
			// never fails here — but stay total: a failure leaves churn null, never throws.
			if (Result.isSuccess(priced)) {
				const c = priced.success;
				churn = {
					expectedExtraCycles: c.expectedExtraCycles,
					churnTokens: c.churnTokens,
					amortizedBilledPerRun: c.amortizedTokensPerRun,
				};

				const isBaselineCell =
					baselineBucket !== undefined &&
					bucket.stage === baselineBucket.stage &&
					bucket.model === baselineBucket.model;
				if (baselineSpend !== null && !isBaselineCell) {
					const swap = priceModelSwap({
						baselineTokensPerRun: baselineSpend.billedPerRun,
						candidate: {
							passRate,
							tokensPerRun: spend.billedPerRun,
							tokensPerRepairCycle: repairCycle,
						},
					});
					if (Result.isSuccess(swap)) {
						netSaving = swap.success.netSaving;
						netNegative = Number.isFinite(netSaving) && netSaving < 0;
					}
				}
			}
		}

		return {
			stage: bucket.stage,
			model: bucket.model,
			gradedRuns: bucket.graded,
			passedRuns: bucket.passed,
			passRate,
			spend,
			churn,
			netSaving,
			netNegative,
		};
	});

	return {
		decisionRef: DECISION_POINTER,
		framing: DECISION_FRAMING,
		baseline:
			baselineBucket !== undefined
				? {stage: baselineBucket.stage, model: baselineBucket.model}
				: null,
		cells,
	};
};

/**
 * The stable, documented machine-readable form of a scorecard — the exact JSON a future gate
 * or CI consumes. It is the `Scorecard` interface serialized as-is (field names + nesting are
 * the contract, documented in README.md); a consumer decodes this shape. Kept as a thin
 * projection so the JSON shape and the in-memory type never drift.
 */
export const toJson = (scorecard: Scorecard): string => `${JSON.stringify(scorecard, null, 2)}\n`;

const num = (n: number): string =>
	Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : n > 0 ? "+∞" : "-∞";

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const signedNum = (n: number | null): string => {
	if (n === null) return "—";
	if (!Number.isFinite(n)) return n > 0 ? "+∞" : "-∞";
	const rounded = Math.round(n);
	return rounded > 0 ? `+${rounded.toLocaleString("en-US")}` : rounded.toLocaleString("en-US");
};

/**
 * Render the human-readable table the founder reads to decide #1576 (`token-spend`/`ship-digest`
 * reporter idiom). One row per (stage × model): pass-rate, per-run billed + ex-cache-read spend,
 * churn-amortized billed, and net saving vs the baseline. A net-negative cell is marked
 * `NET-NEGATIVE` unambiguously — the epic's headline risk made impossible to miss. The framing
 * line states this is evidence for #1576, never a recommendation.
 */
export const renderTable = (scorecard: Scorecard): string => {
	const lines: Array<string> = [];
	lines.push("eval-harness scorecard — graded two-axis gate (pass-rate × net-token cost)");
	lines.push(scorecard.framing);
	if (scorecard.baseline !== null) {
		lines.push(
			`baseline: ${scorecard.baseline.stage} × ${scorecard.baseline.model ?? "(unknown model)"} ` +
				"— net saving is measured against this cell",
		);
	}
	lines.push("");

	const header = [
		"stage",
		"model",
		"pass-rate",
		"billed/run",
		"ex-cache/run",
		"amortized/run",
		"net-saving",
		"",
	];
	const rows = scorecard.cells.map((cell) => [
		cell.stage,
		cell.model ?? "(unknown)",
		`${pct(cell.passRate)} (${cell.passedRuns}/${cell.gradedRuns})`,
		cell.spend === null ? "—" : num(cell.spend.billedPerRun),
		cell.spend === null ? "—" : num(cell.spend.exCacheReadPerRun),
		cell.churn === null ? "—" : num(cell.churn.amortizedBilledPerRun),
		signedNum(cell.netSaving),
		cell.netNegative ? "NET-NEGATIVE (churn ate the saving)" : "",
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
	for (const r of rows) lines.push(fmt(r));

	return lines.join("\n");
};

// --- The report's on-disk input: a serialized array of runner rows (`RunRow[]`) --------------
//
// The report command reads the runner's graded rows from a JSON file — the array `collectRuns`
// produces, serialized. These schemas decode that file totally: a malformed body or a shape
// mismatch returns a typed `Result` failure, never a throw (mirrors `decodeManifest`).

const StageSpendSchema = Schema.Struct({
	input: Schema.Finite,
	cacheCreate: Schema.Finite,
	cacheRead: Schema.Finite,
	output: Schema.Finite,
	billed: Schema.Finite,
	exCacheRead: Schema.Finite,
	assistantTurns: Schema.Finite,
	model: Schema.NullOr(Schema.String),
});

const RunSpendSchema = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("Reconstructed"), spend: StageSpendSchema}),
	Schema.Struct({_tag: Schema.Literal("TranscriptMissing")}),
]);

const FieldMismatchSchema = Schema.Struct({
	field: Schema.String,
	observed: Schema.String,
	expected: Schema.String,
});

const MismatchSchema = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("MalformedArtifact"), reason: Schema.String}),
	Schema.Struct({_tag: Schema.Literal("LabelMismatch"), fields: Schema.Array(FieldMismatchSchema)}),
]);

const GradeSchema = Schema.Union([
	Schema.Struct({status: Schema.Literal("pass")}),
	Schema.Struct({status: Schema.Literal("fail"), mismatch: MismatchSchema}),
]);

const RunRowSchema = Schema.Struct({
	entry: CorpusEntry,
	grade: GradeSchema,
	spend: RunSpendSchema,
});

/** The report's input file: the array of graded rows `collectRuns` emits, serialized to JSON. */
export const ReportInput = Schema.Array(RunRowSchema);

export type ReportInput = typeof ReportInput.Type;

/** A typed report-input decode failure — malformed JSON, or a shape that doesn't match the rows schema. */
export class ReportInputError extends Data.TaggedError("ReportInputError")<{
	readonly reason: "malformed-json" | "schema-mismatch";
	readonly message: string;
}> {}

const decodeUnknownReportInput = Schema.decodeUnknownResult(ReportInput);

/**
 * Decode the report's input (a serialized `RunRow[]`) from its on-disk text. Total — a non-JSON
 * body or a schema mismatch both return a typed `Result` failure, never a throw.
 */
export const decodeReportInput = (text: string): Result.Result<ReportInput, ReportInputError> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		return Result.fail(
			new ReportInputError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		);
	}
	return decodeUnknownReportInput(parsed).pipe(
		Result.mapError(
			(error) => new ReportInputError({reason: "schema-mismatch", message: error.message}),
		),
	);
};
