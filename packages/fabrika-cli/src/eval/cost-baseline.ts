/**
 * The v1 cost baseline — what the old suite spent on the incident corpus, and the one question a
 * later fabrika run is asked against it (issue #4679, epic #4649).
 *
 * Phase 1 of the ruled cost axis is `fabrika spend ≤ v1 spend on the same corpus` (#4637 ruling 3),
 * which needs two things this module supplies and nothing else does: a **committed, dated record**
 * of what v1 cost, pinned tightly enough that a later measurement is apples-to-apples, and a
 * **mechanical comparison** that answers at-or-below / above rather than leaving a reader to eyeball
 * two token totals.
 *
 * It mints **no meter**. Every number here is folded out of spend-ledger rows that
 * `../spend/token-spend.ts` already reconstructed (ADR 0112 §2) and `../spend/ledger.ts` already
 * persisted; re-deriving either would break comparability against every prior cost effort. The one
 * arithmetic it performs is addition and a division by the run count.
 *
 * Two refusals carry the weight, and both are the same rule the rest of the harness runs on — a
 * number that was not measured is never fabricated:
 *
 * 1. **A baseline over zero measured runs is refused, not recorded as zero** (ADR 0092). A ledger
 *    whose every row is `TranscriptMissing` describes a suite nobody could measure, and a `0` there
 *    reads exactly like a suite that was free.
 * 2. **A comparison whose two sides are not the same measurement is `incomparable`, never a pass.**
 *    A different case count, a different model, or an unmeasured candidate all resolve to a third
 *    answer with its reason stated — the below-the-line direction is only ever reported when the two
 *    sides genuinely priced the same work.
 *
 * The comparable unit is the **corpus-level total**, per the #4679 amendment of 2026-08-08: the two
 * arms' skill sets are many-to-one and one-to-many (v1's five review skills land on fabrika's one,
 * v1's `write-code` splits in two, three v1 skills have no counterpart), so no stage key is shared
 * and a stage-keyed row cannot be the ceiling. Per-run figures ride along as context.
 *
 * Phase 2 — absolute per-stage budgets — is deferred by the same ruling until roughly three months
 * of fabrika's own p95 data exist. {@link PHASE_2_DEFERRAL} is the sentence every recorded baseline
 * carries, and the schema requires it, so no reader has to know the ruling to find out.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";
import {canonicalModel} from "../models.ts";
import type {LedgerRow} from "../spend/ledger.ts";

/** The shape version stamped on a recorded baseline. */
export const COST_BASELINE_VERSION = 1;

/** The deferral every recorded baseline states, so the artifact answers AC4 without a cross-read. */
export const PHASE_2_DEFERRAL =
	"Phase 2 (absolute per-stage token budgets) is deferred per the #4637 ruling until roughly " +
	"three months of fabrika's own p95 data exist. This artifact introduces no per-stage budget.";

/** Which corpus revision the runs priced — the pin that makes a later comparison apples-to-apples. */
const Corpus = Schema.Struct({
	/** Repo-relative path to the ruled-KEEP enumeration the feedstock is counted from. */
	path: Schema.String,
	/** The commit the corpus files were read at. */
	revision: Schema.String,
	members: Schema.Int,
	pending: Schema.Int,
	/** Authored eval cases in the set that was executed — the corpus as *run*, not as *enumerated*. */
	cases: Schema.Int,
});

/**
 * How the runs were produced. `revision` is the harness version: a commit pins the harness exactly,
 * where the package's semver has never moved off `0.1.0` and so pins nothing.
 */
const Harness = Schema.Struct({
	runner: Schema.String,
	/** The plugin dir that made this the v1 arm — the adapter AC5 asks the artifact to record. */
	pluginDir: Schema.String,
	arm: Schema.String,
	model: Schema.String,
	cliVersion: Schema.NullOr(Schema.String),
	revision: Schema.String,
});

const Runs = Schema.Struct({
	cases: Schema.Int,
	measured: Schema.Int,
	unmeasured: Schema.Int,
});

const Spend = Schema.Struct({
	billed: Schema.Finite,
	exCacheRead: Schema.Finite,
	billedPerRun: Schema.Finite,
	exCacheReadPerRun: Schema.Finite,
});

/** The wire shape of a committed baseline under `claude-plugins/fabrika/reports/eval/`. */
export const CostBaselineFile = Schema.Struct({
	v: Schema.Literal(COST_BASELINE_VERSION),
	/** Which suite was measured — `v1` for the published SOTA proof's baseline arm. */
	suite: Schema.String,
	recordedAt: Schema.String,
	corpus: Corpus,
	harness: Harness,
	runs: Runs,
	spend: Spend,
	phase2: Schema.String,
});

export type CostBaseline = typeof CostBaselineFile.Type;

/** Why a baseline could not be built from the rows in scope. */
export class CostBaselineError extends Schema.TaggedErrorClass<CostBaselineError>()(
	"CostBaselineError",
	{
		reason: Schema.Literals(["no-rows", "no-measured-runs", "mixed-model", "mixed-cli-version"]),
		message: Schema.String,
	},
) {}

/** A typed baseline-file decode failure — malformed JSON, or a shape that doesn't match. */
export class CostBaselineDecodeError extends Schema.TaggedErrorClass<CostBaselineDecodeError>()(
	"CostBaselineDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

/** What a set of ledger rows measured, before any pin is attached to it. */
export interface LedgerFold {
	readonly model: string;
	readonly cliVersion: string | null;
	readonly runs: typeof Runs.Type;
	readonly spend: typeof Spend.Type;
}

const distinct = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(values)].sort();

/**
 * Fold spend-ledger rows into the totals a baseline (or a candidate) is stated in.
 *
 * The two identity refusals are what make the fold a *measurement* rather than an average: rows from
 * two models, or from two CLI versions, are two experiments, and a baseline that names one of them
 * would understate or overstate the other by an unknown amount.
 */
export const foldLedgerRows = (
	rows: ReadonlyArray<LedgerRow>,
): Result.Result<LedgerFold, CostBaselineError> => {
	if (rows.length === 0) {
		return Result.fail(
			new CostBaselineError({
				reason: "no-rows",
				message:
					"no spend-ledger rows are in scope — a baseline over nothing is refused (ADR 0092)",
			}),
		);
	}

	const models = distinct(rows.map((row) => canonicalModel(row.model) ?? "(unrecorded)"));
	if (models.length > 1) {
		return Result.fail(
			new CostBaselineError({
				reason: "mixed-model",
				message: `rows name ${models.length} models (${models.join(", ")}) — a baseline is comparable only when it names one`,
			}),
		);
	}

	const cliVersions = distinct(rows.map((row) => row.cliVersion ?? "(unrecorded)"));
	if (cliVersions.length > 1) {
		return Result.fail(
			new CostBaselineError({
				reason: "mixed-cli-version",
				message: `rows name ${cliVersions.length} CLI versions (${cliVersions.join(", ")}) — the pin #4637 requires names one`,
			}),
		);
	}

	let billed = 0;
	let exCacheRead = 0;
	let measured = 0;
	for (const row of rows) {
		if (row.spend._tag !== "Reconstructed") continue;
		measured += 1;
		billed += row.spend.spend.billed;
		exCacheRead += row.spend.spend.exCacheRead;
	}

	if (measured === 0) {
		return Result.fail(
			new CostBaselineError({
				reason: "no-measured-runs",
				message: `${rows.length} row(s) are in scope and none carries a reconstructed spend — refusing to record a baseline of zero`,
			}),
		);
	}

	const [model = "(unrecorded)"] = models;
	const [cliVersion = "(unrecorded)"] = cliVersions;
	return Result.succeed({
		model,
		cliVersion: cliVersion === "(unrecorded)" ? null : cliVersion,
		runs: {
			cases: distinct(rows.map((row) => String(row.caseId))).length,
			measured,
			unmeasured: rows.length - measured,
		},
		spend: {
			billed,
			exCacheRead,
			billedPerRun: billed / measured,
			exCacheReadPerRun: exCacheRead / measured,
		},
	});
};

/** The pins a fold cannot derive from the rows and a caller must supply. */
export interface CostBaselinePins {
	readonly suite: string;
	readonly recordedAt: string;
	readonly corpus: {
		readonly path: string;
		readonly revision: string;
		readonly members: number;
		readonly pending: number;
		readonly cases: number;
	};
	readonly harness: {
		readonly runner: string;
		readonly pluginDir: string;
		readonly arm: string;
		readonly revision: string;
	};
}

/** Fold the rows and attach the pins — the whole of what `baseline record` writes to disk. */
export const buildCostBaseline = (args: {
	readonly rows: ReadonlyArray<LedgerRow>;
	readonly pins: CostBaselinePins;
}): Result.Result<CostBaseline, CostBaselineError> =>
	foldLedgerRows(args.rows).pipe(
		Result.map((fold) => ({
			v: COST_BASELINE_VERSION as typeof COST_BASELINE_VERSION,
			suite: args.pins.suite,
			recordedAt: args.pins.recordedAt,
			corpus: args.pins.corpus,
			harness: {...args.pins.harness, model: fold.model, cliVersion: fold.cliVersion},
			runs: fold.runs,
			spend: fold.spend,
			phase2: PHASE_2_DEFERRAL,
		})),
	);

/**
 * The comparison's three answers. `incomparable` is a real answer, not a soft failure: it is what
 * the surface must say when the two sides did not price the same work, and it is never read as a
 * pass.
 */
export type BaselineVerdict = "at-or-below" | "above" | "incomparable";

export interface BaselineComparison {
	readonly verdict: BaselineVerdict;
	/** Always populated — an `incomparable` states what disqualified it, the others state the margin. */
	readonly reason: string;
	readonly baselineBilled: number;
	readonly candidateBilled: number;
	/** `candidate − baseline`; negative is under the ceiling. Null when the two are incomparable. */
	readonly deltaBilled: number | null;
}

/**
 * Answer the one question phase 1 asks: is this candidate's spend on the same corpus at or below the
 * baseline's?
 *
 * The guards run before the arithmetic and in this order because each later one presumes the earlier
 * held. Equality passes — the ruled bar is "≤ v1", so a candidate that ties the baseline is inside
 * it.
 */
export const compareToBaseline = (
	baseline: CostBaseline,
	candidate: LedgerFold,
): BaselineComparison => {
	const both = {
		baselineBilled: baseline.spend.billed,
		candidateBilled: candidate.spend.billed,
	};

	if (candidate.runs.measured === 0) {
		return {
			...both,
			verdict: "incomparable",
			reason: "the candidate measured no runs — there is nothing to price against the baseline",
			deltaBilled: null,
		};
	}
	if (candidate.runs.cases !== baseline.runs.cases) {
		return {
			...both,
			verdict: "incomparable",
			reason: `the candidate covered ${candidate.runs.cases} corpus case(s), the baseline ${baseline.runs.cases} — a total over a different case set is not the same corpus`,
			deltaBilled: null,
		};
	}
	if (candidate.model !== canonicalModel(baseline.harness.model)) {
		return {
			...both,
			verdict: "incomparable",
			reason: `the candidate ran on ${candidate.model}, the baseline on ${baseline.harness.model} — a cost ceiling holds one model fixed`,
			deltaBilled: null,
		};
	}

	const delta = candidate.spend.billed - baseline.spend.billed;
	return {
		...both,
		verdict: delta <= 0 ? "at-or-below" : "above",
		// `Math.abs` before rounding, not after negating: an exact tie negates to `-0`, which formats
		// as "-0 tokens under" and reads like a defect in the arithmetic rather than a clean pass.
		reason: `candidate billed ${Math.round(Math.abs(delta)).toLocaleString("en-US")} token(s) ${delta <= 0 ? "under" : "over"} the baseline over ${baseline.runs.cases} case(s)`,
		deltaBilled: delta,
	};
};

const decodeUnknownBaseline = Schema.decodeUnknownResult(CostBaselineFile);

/** Decode a committed baseline. Total — malformed JSON and a shape mismatch are typed failures. */
export const decodeCostBaseline = (
	text: string,
): Result.Result<CostBaseline, CostBaselineDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new CostBaselineDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownBaseline(parsed).pipe(
				Result.mapError(
					(error) =>
						new CostBaselineDecodeError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
	);

/**
 * Tab-indented, unlike `report.ts`'s `toJson`: this output is *committed*, so it is formatted the way
 * biome formats committed JSON. A two-space file reds `pnpm lint` the moment it lands, and the fix
 * would then be to reformat by hand every time a baseline is recorded.
 */
export const costBaselineToJson = (baseline: CostBaseline): string =>
	`${JSON.stringify(baseline, null, "\t")}\n`;

const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The human read of a recorded baseline — every pin on the page, so nothing needs a cross-read. */
export const renderCostBaseline = (baseline: CostBaseline): string =>
	[
		`fabrika cost baseline — suite '${baseline.suite}' on the incident corpus`,
		`recorded at ${baseline.recordedAt}`,
		"",
		`corpus:  ${baseline.corpus.path} @ ${baseline.corpus.revision}`,
		`         ${baseline.corpus.members} member(s) + ${baseline.corpus.pending} pending · ${baseline.corpus.cases} authored case(s)`,
		`harness: ${baseline.harness.runner} --plugin-dir ${baseline.harness.pluginDir} (arm ${baseline.harness.arm})`,
		`         model ${baseline.harness.model} · CLI ${baseline.harness.cliVersion ?? "(unrecorded)"} · harness @ ${baseline.harness.revision}`,
		`runs:    ${baseline.runs.cases} case(s) · ${baseline.runs.measured} measured · ${baseline.runs.unmeasured} unmeasured`,
		"",
		`billed:       ${num(baseline.spend.billed)} total · ${num(baseline.spend.billedPerRun)}/run`,
		`ex-cache-read: ${num(baseline.spend.exCacheRead)} total · ${num(baseline.spend.exCacheReadPerRun)}/run`,
		"",
		baseline.phase2,
	].join("\n");

/** The human read of the comparison — the verdict first, because it is the whole answer. */
export const renderBaselineComparison = (comparison: BaselineComparison): string =>
	[
		`fabrika cost baseline — ${comparison.verdict.toUpperCase()}`,
		comparison.reason,
		"",
		`baseline billed:  ${num(comparison.baselineBilled)}`,
		`candidate billed: ${num(comparison.candidateBilled)}`,
	].join("\n");
