/**
 * The eval report core — the graded two-axis scorecard (issue #1853, epic #1842).
 *
 * The top of the eval vertical slice and the evidence artifact the model-tiering
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
 *
 * A pass-rate measures ONE grading regime, so a cell is keyed by (stage × surface × model), not
 * stage alone: see `CellIdentity` and ADR 0243 §4.
 */
import {Effect, Result} from "effect";
import * as Schema from "effect/Schema";
import {canonicalModel} from "../models.ts";
import {CorpusEntry, type ReviewSurface} from "./corpus.ts";
import {priceModelSwap, repairChurnCost} from "./repair-churn.ts";
import {EVAL_ARMS, type RunRow} from "./runner.ts";

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

/**
 * Which grading regime a cell's rows came from — the non-model half of the bucket key.
 *
 * A `review` cell MUST name the surface whose grader produced it, and every other stage carries no
 * surface, so a bare `review` cell is unrepresentable rather than merely unproduced (ADR 0243 §4).
 * A recorded v1 key (`review-code`) is provenance, not a live `review` row, so it takes the
 * surfaceless arm (#4977).
 */
export type CellIdentity =
	| {readonly stage: "review"; readonly surface: ReviewSurface}
	| {readonly stage: Exclude<CorpusEntry["stage"], "review">; readonly surface: null};

/** The two-axis picture for one (stage × surface × model) cell of the scorecard. */
export type ScorecardCell = CellIdentity & {
	/**
	 * The model the runs used: the one the run recorded, else the one its transcript reconstructs
	 * to. `null` only when neither attests one.
	 */
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
};

/** The whole scorecard: the framing pointer plus one cell per (stage × surface × model). */
export interface Scorecard {
	/** The decision this evidence feeds (#1576) — the report never makes it. */
	readonly decisionRef: number;
	readonly framing: string;
	/** The cell chosen as the per-run baseline saving is measured against, if any. */
	readonly baseline: (CellIdentity & {readonly model: string | null}) | null;
	readonly cells: ReadonlyArray<ScorecardCell>;
}

/**
 * Which cell to price the other cells' net saving against. `surface` is what makes this select at
 * most one cell: omit it on a non-review stage, and name it on `review`, where a surfaceless key
 * matches no cell rather than picking a grading regime arbitrarily.
 */
export interface BaselineKey {
	readonly stage: CorpusEntry["stage"];
	readonly surface?: ReviewSurface;
	readonly model: string | null;
}

const identityOf = (entry: CorpusEntry): CellIdentity =>
	entry.stage === "review"
		? {stage: "review", surface: entry.surface}
		: {stage: entry.stage, surface: null};

// NUL-separated so no stage/surface/model value can spell a neighbouring key and merge two cells.
const cellKey = (id: CellIdentity, model: string | null): string =>
	`${id.stage}\u0000${id.surface ?? ""}\u0000${model ?? ""}`;

// The baseline's model is canonicalized on the way in for the same reason a row's is: a baseline
// named in the other spelling of the cell's model matched nothing and reported `null` rather than
// reporting wrong, which is fail-quiet (#5158).
const sameCell = (a: {id: CellIdentity; model: string | null}, b: BaselineKey): boolean =>
	a.id.stage === b.stage &&
	a.id.surface === (b.surface ?? null) &&
	a.model === canonicalModel(b.model);

interface Bucket {
	readonly id: CellIdentity;
	readonly model: string | null;
	graded: number;
	passed: number;
	billedSum: number;
	exCacheReadSum: number;
	reconstructed: number;
	transcriptMissing: number;
}

/**
 * Which model a row is bucketed under. The run's own recorded model wins over the one its
 * transcript reconstructs to: the recorded value is what the run was *pinned* to, while the
 * transcript is machine-local and perishable, so reconstruction is the fallback for a row that
 * recorded nothing — not the source (#4996). A row with a recorded model therefore keeps its
 * bucket even when its transcript is gone, instead of collapsing into `(unknown)`.
 *
 * Whichever of the two attests it, the spelling is canonicalized through fabrika's one alias table
 * (`../models.ts`) before it becomes a bucket key, so an alias and its canonical id are one cell
 * rather than two pass-rates over the same model (#5158). An unknown model canonicalizes to itself
 * and keeps its own cell — this normalizes, it never allowlists.
 */
const modelOf = (row: RunRow): string | null =>
	canonicalModel(
		row.provenance.model ?? (row.spend._tag === "Reconstructed" ? row.spend.spend.model : null),
	);

const bucketize = (rows: ReadonlyArray<RunRow>): ReadonlyArray<Bucket> => {
	const byKey = new Map<string, Bucket>();
	for (const row of rows) {
		const model = modelOf(row);
		const id = identityOf(row.entry);
		const key = cellKey(id, model);
		let bucket = byKey.get(key);
		if (bucket === undefined) {
			bucket = {
				id,
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
			// Both no-measurement arms (`TranscriptMissing`, `NoBilledTurns`) land here: neither
			// contributes to the per-run averages, which is what keeps a fabricated zero out of the
			// spend axis. Giving `NoBilledTurns` its own scorecard column belongs to #4680.
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
	readonly tokensPerRepairCycle?: (cell: CellIdentity & {model: string | null}) => number;
}): Scorecard => {
	const buckets = bucketize(args.rows);
	const baseline = args.baseline;
	// Bucket keys are unique on (stage, surface, model) and `sameCell` compares that whole key, so
	// this finds at most one bucket: a `review` baseline naming no surface matches nothing rather
	// than silently adopting one of the two graders as the baseline.
	const baselineBucket =
		baseline === undefined ? undefined : buckets.find((b) => sameCell(b, baseline));
	const baselineSpend = baselineBucket !== undefined ? spendOf(baselineBucket) : null;

	const cells = buckets.map((bucket): ScorecardCell => {
		const passRate = bucket.graded === 0 ? 0 : bucket.passed / bucket.graded;
		const spend = spendOf(bucket);

		let churn: CellChurn | null = null;
		let netSaving: number | null = null;
		let netNegative = false;

		if (spend !== null) {
			const repairCycle =
				args.tokensPerRepairCycle?.({...bucket.id, model: bucket.model}) ?? spend.billedPerRun;
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

				const isBaselineCell = bucket === baselineBucket;
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
			...bucket.id,
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
			baselineBucket !== undefined ? {...baselineBucket.id, model: baselineBucket.model} : null,
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
 * reporter idiom). One row per (stage × surface × model): pass-rate, per-run billed + ex-cache-read
 * spend, churn-amortized billed, and net saving vs the baseline. A net-negative cell is marked
 * `NET-NEGATIVE` unambiguously — the epic's headline risk made impossible to miss. The framing
 * line states this is evidence for #1576, never a recommendation.
 */
export const renderTable = (scorecard: Scorecard): string => {
	const lines: Array<string> = [];
	lines.push("fabrika eval scorecard — graded two-axis gate (pass-rate × net-token cost)");
	lines.push(scorecard.framing);
	if (scorecard.baseline !== null) {
		const surface = scorecard.baseline.surface === null ? "" : ` (${scorecard.baseline.surface})`;
		lines.push(
			`baseline: ${scorecard.baseline.stage}${surface} × ` +
				`${scorecard.baseline.model ?? "(unknown model)"} — net saving is measured against this cell`,
		);
	}
	lines.push("");

	const header = [
		"stage",
		"surface",
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
		cell.surface ?? "—",
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

// On-disk input: a serialized array of runner rows (`RunRow[]`) — the array `collectRuns`
// produces. These schemas decode it totally: a malformed body or shape mismatch returns a
// typed `Result` failure, never a throw (mirrors `decodeManifest`).

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
	Schema.Struct({_tag: Schema.Literal("NoBilledTurns")}),
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

// A rows file written before provenance existed carries no `provenance` key, and must keep decoding
// — it degrades to the transcript-reconstruction bucketing that was the only source back then.
const RunProvenanceSchema = Schema.Struct({
	model: Schema.NullOr(Schema.String),
	arm: Schema.NullOr(Schema.Literals([...EVAL_ARMS])),
});

const RunRowSchema = Schema.Struct({
	entry: CorpusEntry,
	grade: GradeSchema,
	spend: RunSpendSchema,
	provenance: RunProvenanceSchema.pipe(
		Schema.withDecodingDefault(Effect.succeed({model: null, arm: null})),
	),
});

/** The report's input file: the array of graded rows `collectRuns` emits, serialized to JSON. */
export const ReportInput = Schema.Array(RunRowSchema);

export type ReportInput = typeof ReportInput.Type;

/** A typed report-input decode failure — malformed JSON, or a shape that doesn't match the rows schema. */
export class ReportInputError extends Schema.TaggedErrorClass<ReportInputError>()(
	"ReportInputError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const decodeUnknownReportInput = Schema.decodeUnknownResult(ReportInput);

/**
 * Decode the report's input (a serialized `RunRow[]`) from its on-disk text. Total — a non-JSON
 * body or a schema mismatch both return a typed `Result` failure, never a throw.
 */
export const decodeReportInput = (text: string): Result.Result<ReportInput, ReportInputError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new ReportInputError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownReportInput(parsed).pipe(
				Result.mapError(
					(error) => new ReportInputError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
	);
