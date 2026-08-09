import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {MODEL_ALIASES} from "../models.ts";
import type {StageSpend} from "../spend/token-spend.ts";
import type {CorpusEntry} from "./corpus.ts";
import {
	buildScorecard,
	type CellIdentity,
	DECISION_POINTER,
	decodeReportInput,
	renderTable,
	type ScorecardCell,
	toJson,
} from "./report.ts";
import type {RunProvenance, RunRow} from "./runner.ts";

/** `true` iff `T` is a cell identity the report can key on — the type-level probe's operand. */
type IsCell<T> = T extends CellIdentity ? true : false;

// A triage corpus entry — the report only reads `entry.stage`, so any stage's entry serves.
const triageEntry = (inputRef: number): CorpusEntry => ({
	stage: "triage",
	inputRef,
	label: {type: "bug", priority: "p0", status: "triaged"},
});

// A reconstructed StageSpend fixture: `billed` and `exCacheRead` are the only fields the report
// reads off the spend (plus `model` for bucketing).
const spend = (billed: number, model: string): StageSpend => ({
	input: billed,
	cacheCreate: 0,
	cacheRead: 0,
	output: 0,
	billed,
	exCacheRead: billed,
	assistantTurns: 1,
	model,
});

// A row that recorded no provenance — the pre-#4996 shape, which buckets off the transcript alone.
const unrecorded: RunProvenance = {model: null, arm: null};

// One graded run row: a pass/fail grade + a reconstructed spend at `billed` tokens on `model`.
const row = (opts: {
	pass: boolean;
	billed: number;
	model: string;
	inputRef?: number;
	provenance?: RunProvenance;
}): RunRow => ({
	entry: triageEntry(opts.inputRef ?? 1),
	grade: opts.pass
		? {status: "pass"}
		: {status: "fail", mismatch: {_tag: "MalformedArtifact", reason: "x"}},
	spend: {_tag: "Reconstructed", spend: spend(opts.billed, opts.model)},
	provenance: opts.provenance ?? unrecorded,
});

const missingSpendRow = (opts: {
	pass: boolean;
	inputRef?: number;
	provenance?: RunProvenance;
}): RunRow => ({
	entry: triageEntry(opts.inputRef ?? 1),
	grade: opts.pass
		? {status: "pass"}
		: {status: "fail", mismatch: {_tag: "MalformedArtifact", reason: "x"}},
	spend: {_tag: "TranscriptMissing"},
	provenance: opts.provenance ?? unrecorded,
});

const cellFor = (cells: ReadonlyArray<ScorecardCell>, model: string | null): ScorecardCell => {
	const found = cells.find((c) => c.model === model);
	assert.isDefined(found, `expected a cell for model ${model}`);
	return found as ScorecardCell;
};

// A live `review` entry on either surface — the two label shapes ADR 0243 §1 fixes.
const reviewEntry = (surface: "code" | "doc", inputRef: number): CorpusEntry =>
	surface === "code"
		? {stage: "review", surface: "code", inputRef, label: {verdict: "PASS", acFindings: []}}
		: {stage: "review", surface: "doc", inputRef, label: {verdict: "PASS", findings: []}};

// A row the v1 `review-code` gate recorded: provenance, carrying no `surface` (#4977).
const recordedReviewCodeEntry = (inputRef: number): CorpusEntry => ({
	stage: "review-code",
	inputRef,
	label: {verdict: "PASS", acFindings: []},
});

const entryRow = (opts: {
	entry: CorpusEntry;
	pass: boolean;
	billed: number;
	model: string;
}): RunRow => ({
	entry: opts.entry,
	grade: opts.pass
		? {status: "pass"}
		: {status: "fail", mismatch: {_tag: "MalformedArtifact", reason: "x"}},
	spend: {_tag: "Reconstructed", spend: spend(opts.billed, opts.model)},
	provenance: unrecorded,
});

const reviewCellFor = (
	cells: ReadonlyArray<ScorecardCell>,
	surface: "code" | "doc",
): ScorecardCell => {
	const found = cells.find((c) => c.stage === "review" && c.surface === surface);
	assert.isDefined(found, `expected a review cell for surface ${surface}`);
	return found as ScorecardCell;
};

describe("buildScorecard — single (stage × model)", () => {
	it("computes pass-rate and mean per-run billed + ex-cache-read spend for one cell", () => {
		// 3 runs, 2 pass ⇒ pass-rate 2/3; billed 100/200/300 ⇒ mean 200.
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 100, model: "opus-4.8"}),
			row({pass: true, billed: 200, model: "opus-4.8"}),
			row({pass: false, billed: 300, model: "opus-4.8"}),
		];
		const sc = buildScorecard({rows});
		assert.strictEqual(sc.cells.length, 1);
		const cell = cellFor(sc.cells, "opus-4.8");
		assert.strictEqual(cell.stage, "triage");
		assert.strictEqual(cell.gradedRuns, 3);
		assert.strictEqual(cell.passedRuns, 2);
		assert.approximately(cell.passRate, 2 / 3, 1e-9);
		assert.isNotNull(cell.spend);
		assert.strictEqual(cell.spend?.billedPerRun, 200);
		assert.strictEqual(cell.spend?.exCacheReadPerRun, 200);
		assert.isNotNull(cell.churn);
		// No baseline named ⇒ no net saving computed on a lone cell.
		assert.isNull(cell.netSaving);
		assert.isFalse(cell.netNegative);
	});

	it("a transcript-missing run counts toward pass-rate but not toward the spend mean", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 100, model: "opus-4.8"}),
			missingSpendRow({pass: true}),
		];
		const sc = buildScorecard({rows});
		// Both runs land in the same (stage × model) cell — the missing-transcript run has model null,
		// so it buckets separately. Assert the two are distinct and both counted.
		const opusCell = cellFor(sc.cells, "opus-4.8");
		assert.strictEqual(opusCell.gradedRuns, 1);
		assert.strictEqual(opusCell.spend?.billedPerRun, 100);
		const nullCell = cellFor(sc.cells, null);
		assert.strictEqual(nullCell.gradedRuns, 1);
		assert.strictEqual(nullCell.passedRuns, 1);
		// A cell with no reconstructed spend reports a null token axis, not a fabricated zero.
		assert.isNull(nullCell.spend);
		assert.isNull(nullCell.churn);
	});
});

describe("buildScorecard — multi-model comparison against a baseline", () => {
	it("prices each candidate's net saving against the named baseline cell", () => {
		// Baseline: opus, pass-rate 1.0, 1000 billed/run ⇒ zero churn, amortized 1000.
		// Candidate: sonnet, pass-rate 1.0, 400 billed/run ⇒ zero churn, amortized 400.
		// Net saving of sonnet = baseline 1000 − sonnet amortized 400 = +600.
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 1000, model: "opus-4.8", inputRef: 1}),
			row({pass: true, billed: 400, model: "sonnet", inputRef: 2}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus-4.8"}});
		assert.isNotNull(sc.baseline);
		assert.strictEqual(sc.baseline?.model, "opus-4.8");

		const opus = cellFor(sc.cells, "opus-4.8");
		// The baseline cell measures no net saving against itself.
		assert.isNull(opus.netSaving);
		assert.isFalse(opus.netNegative);

		const sonnet = cellFor(sc.cells, "sonnet");
		assert.strictEqual(sonnet.churn?.churnTokens, 0);
		assert.strictEqual(sonnet.netSaving, 600);
		assert.isFalse(sonnet.netNegative);
	});
});

describe("buildScorecard — the net-negative churn case (the epic's headline risk)", () => {
	it("a cheaper-but-flakier model whose churn exceeds its per-run saving renders net-negative", () => {
		// Baseline: opus, pass-rate 1.0, 1000 billed/run ⇒ amortized 1000.
		// Candidate: sonnet, pass-rate 0.5, 700 billed/run (naive saving 300/run).
		//   expected extra cycles = (1−0.5)/0.5 = 1; churn = 1 × 700 = 700; amortized = 700 + 700 = 1400.
		//   net saving = 1000 − 1400 = −400 ⇒ NET-NEGATIVE: churn ate the saving.
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 1000, model: "opus-4.8", inputRef: 1}),
			row({pass: true, billed: 700, model: "sonnet", inputRef: 2}),
			row({pass: false, billed: 700, model: "sonnet", inputRef: 3}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus-4.8"}});
		const sonnet = cellFor(sc.cells, "sonnet");
		assert.approximately(sonnet.passRate, 0.5, 1e-9);
		assert.strictEqual(sonnet.churn?.expectedExtraCycles, 1);
		assert.strictEqual(sonnet.churn?.churnTokens, 700);
		assert.strictEqual(sonnet.churn?.amortizedBilledPerRun, 1400);
		assert.strictEqual(sonnet.netSaving, -400);
		assert.isTrue(sonnet.netNegative);
	});

	it("a never-passing model (pass-rate 0) prices +Infinity churn and is net-negative", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 1000, model: "opus-4.8", inputRef: 1}),
			row({pass: false, billed: 10, model: "flaky", inputRef: 2}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus-4.8"}});
		const flaky = cellFor(sc.cells, "flaky");
		assert.strictEqual(flaky.passRate, 0);
		assert.strictEqual(flaky.churn?.churnTokens, Number.POSITIVE_INFINITY);
		// netSaving = 1000 − Infinity = −Infinity: not a finite number, so not flagged net-negative,
		// but the amortized cost is unbounded (rendered as -∞ saving) — never adopt.
		assert.strictEqual(flaky.netSaving, Number.NEGATIVE_INFINITY);
		assert.isFalse(flaky.netNegative);
	});
});

// ADR 0243 §4: a pass-rate is a measurement over ONE grading regime, so the report's cell key
// carries `surface` and rows from different review surfaces are never aggregated into a single
// undifferentiated `review` number. These assertions are written against rows that ONLY a
// surface-carrying key separates — same stage, same model, same inputRef — so they cannot pass on a
// key built from (stage × model) alone.
describe("buildScorecard — a `review` pass-rate never spans two graders (ADR 0243 §4)", () => {
	// The mixed-surface PR of ADR 0243 §3: one inputRef, one row per surface, two graders.
	const mixedSurfaceRows: ReadonlyArray<RunRow> = [
		entryRow({entry: reviewEntry("code", 42), pass: true, billed: 100, model: "opus-4.8"}),
		entryRow({entry: reviewEntry("doc", 42), pass: false, billed: 100, model: "opus-4.8"}),
	];

	it("buckets the two surfaces of one inputRef separately, each keeping its own pass-rate", () => {
		const sc = buildScorecard({rows: mixedSurfaceRows});

		assert.strictEqual(sc.cells.length, 2);
		const code = reviewCellFor(sc.cells, "code");
		const doc = reviewCellFor(sc.cells, "doc");
		assert.strictEqual(code.gradedRuns, 1);
		assert.strictEqual(code.passRate, 1);
		assert.strictEqual(doc.gradedRuns, 1);
		assert.strictEqual(doc.passRate, 0);
	});

	it("produces no cell that aggregates the two surfaces — the averaged 50% is unproducible", () => {
		const sc = buildScorecard({rows: mixedSurfaceRows});

		// Every cell is homogeneous in its grading regime: the rows it counts are exactly the input
		// rows sharing its full (stage, surface, model) key. A cell that merged the two surfaces would
		// count 2 rows against a 1-row key, so no averaged pass-rate can exist anywhere in the
		// scorecard — not merely be absent from the cell a test happened to look at.
		for (const cell of sc.cells) {
			const matching = mixedSurfaceRows.filter(
				(r) =>
					r.entry.stage === cell.stage &&
					("surface" in r.entry ? r.entry.surface : null) === cell.surface,
			);
			assert.strictEqual(cell.gradedRuns, matching.length);
		}
		assert.isUndefined(sc.cells.find((c) => c.passRate === 0.5));
	});

	it("names the surface on every review cell, in the JSON and in the rendered table", () => {
		const sc = buildScorecard({rows: mixedSurfaceRows});

		const parsed = JSON.parse(toJson(sc)) as {
			cells: ReadonlyArray<{stage: string; surface: string | null}>;
		};
		const reviewCells = parsed.cells.filter((c) => c.stage === "review");
		assert.strictEqual(reviewCells.length, 2);
		assert.deepStrictEqual(
			reviewCells.map((c) => c.surface).sort(),
			["code", "doc"],
			"a `review` cell that did not name its surface would be a bare two-grader number",
		);

		const table = renderTable(sc);
		assert.include(table, "surface");
		for (const line of table.split("\n").filter((l) => l.startsWith("review"))) {
			assert.match(line, /^review\s+(code|doc)\s/);
		}
	});

	it("refuses a surfaceless `review` cell in the type, not only in the built scorecard", () => {
		// The runtime half above proves no averaged cell is BUILT; this proves none can be WRITTEN.
		// `IsCell<T>` is `false` exactly when T is not a `CellIdentity`, so these constants stop
		// compiling the moment `surface` is weakened from a discriminator into an annotation — and the
		// positive controls keep them from being vacuously true.
		const reviewNamesItsSurface: IsCell<{stage: "review"; surface: "code"}> = true;
		const bareReview: IsCell<{stage: "review"; surface: null}> = false;
		const recordedProvenanceCarriesNone: IsCell<{stage: "review-code"; surface: null}> = true;

		assert.isTrue(reviewNamesItsSurface);
		assert.isFalse(bareReview);
		assert.isTrue(recordedProvenanceCarriesNone);
	});

	it("keeps a recorded v1 `review-code` row in its own cell, unmerged with the live surface", () => {
		// A recorded stage key is provenance, never a pointer into the live vocabulary (#4977, ADR
		// 0244) — so it neither gains a surface nor collapses into the live `review` cell.
		const sc = buildScorecard({
			rows: [
				entryRow({entry: recordedReviewCodeEntry(7), pass: true, billed: 100, model: "opus-4.8"}),
				entryRow({entry: reviewEntry("code", 7), pass: false, billed: 100, model: "opus-4.8"}),
			],
		});

		assert.strictEqual(sc.cells.length, 2);
		const recorded = sc.cells.find((c) => c.stage === "review-code");
		assert.isDefined(recorded);
		assert.isNull(recorded?.surface);
		assert.strictEqual(recorded?.gradedRuns, 1);
		assert.strictEqual(reviewCellFor(sc.cells, "code").gradedRuns, 1);
	});
});

describe("buildScorecard — the baseline resolves to exactly one cell under the extended key", () => {
	const rows: ReadonlyArray<RunRow> = [
		entryRow({entry: reviewEntry("code", 1), pass: true, billed: 1000, model: "opus-4.8"}),
		entryRow({entry: reviewEntry("doc", 1), pass: true, billed: 1000, model: "opus-4.8"}),
		entryRow({entry: reviewEntry("code", 2), pass: true, billed: 400, model: "sonnet"}),
	];

	it("a (stage, surface, model) baseline names one cell and prices the others against it", () => {
		const sc = buildScorecard({
			rows,
			baseline: {stage: "review", surface: "code", model: "opus-4.8"},
		});

		assert.isNotNull(sc.baseline);
		assert.strictEqual(sc.baseline?.surface, "code");
		const named = sc.cells.filter(
			(c) =>
				c.stage === sc.baseline?.stage &&
				c.surface === sc.baseline?.surface &&
				c.model === sc.baseline?.model,
		);
		assert.strictEqual(named.length, 1, "the baseline key must select exactly one cell");
		assert.isNull(named[0]?.netSaving ?? null);
		// The doc cell is a different grading regime, so it is priced as a candidate, not merged.
		assert.strictEqual(reviewCellFor(sc.cells, "doc").netSaving, 0);
	});

	it("a surfaceless `review` baseline selects NO cell rather than silently picking one", () => {
		const sc = buildScorecard({rows, baseline: {stage: "review", model: "opus-4.8"}});

		assert.isNull(
			sc.baseline,
			"a baseline that cannot name one grading regime must not resolve to an arbitrary surface",
		);
		for (const cell of sc.cells) assert.isNull(cell.netSaving);
	});
});

/**
 * #4996: the model a run was pinned to is a recorded fact; the transcript is a machine-local,
 * perishable reconstruction of it. So the recorded value sources the bucket key and the
 * reconstruction is only the fallback — otherwise a surviving row loses its model with its
 * transcript and lands in `(unknown)`.
 */
describe("buildScorecard — the bucket key prefers the model the run recorded", () => {
	it("a transcript-missing row with a recorded model keeps its model bucket, not `(unknown)`", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({
				pass: true,
				billed: 100,
				model: "opus-4.8",
				provenance: {model: "opus-4.8", arm: "with-skill"},
			}),
			missingSpendRow({pass: true, provenance: {model: "opus-4.8", arm: "without-skill"}}),
		];
		const sc = buildScorecard({rows});
		assert.strictEqual(sc.cells.length, 1, "both rows belong to the same recorded-model cell");
		const cell = cellFor(sc.cells, "opus-4.8");
		assert.strictEqual(cell.gradedRuns, 2);
		// The unmeasured run still stays out of the spend mean — it is attributed, not fabricated.
		assert.strictEqual(cell.spend?.billedPerRun, 100);
		assert.strictEqual(cell.spend?.transcriptMissingRuns, 1);
		assert.isFalse(renderTable(sc).includes("(unknown)"));
	});

	it("the recorded model wins over a transcript that reconstructs to a different one", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({
				pass: true,
				billed: 100,
				model: "whatever-the-transcript-said",
				provenance: {model: "opus-4.8", arm: "with-skill"},
			}),
		];
		const sc = buildScorecard({rows});
		assert.strictEqual(sc.cells[0]?.model, "opus-4.8");
	});

	it("a row that recorded nothing still buckets on its reconstructed model", () => {
		const sc = buildScorecard({rows: [row({pass: true, billed: 100, model: "sonnet"})]});
		assert.strictEqual(sc.cells[0]?.model, "sonnet");
	});
});

/**
 * #5158 (ruled option B on #5148): one model, one cell. The alias pair is READ from fabrika's one
 * table rather than typed here — a spelling written into a test is the second source the ruling
 * forbids, and it would keep passing after the table moved on.
 */
const aliasEntry = Object.entries(MODEL_ALIASES)[0];
if (aliasEntry === undefined) {
	throw new Error("MODEL_ALIASES declares no alias — there is nothing for the report to normalize");
}
const [aliasedModel, canonicalId] = aliasEntry;

describe("buildScorecard — a model's aliases are one cell, an unknown model is its own", () => {
	it("two spellings of one model produce a single cell, not two pass-rates", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 100, model: aliasedModel, inputRef: 1}),
			row({pass: false, billed: 300, model: canonicalId, inputRef: 2}),
		];
		const sc = buildScorecard({rows});
		assert.strictEqual(sc.cells.length, 1, "the alias and the canonical id are the same model");
		const cell = cellFor(sc.cells, canonicalId);
		assert.strictEqual(cell.gradedRuns, 2);
		assert.strictEqual(cell.passRate, 0.5);
		assert.strictEqual(cell.spend?.billedPerRun, 200);
	});

	it("a model the table has never seen passes through unchanged and keeps its own cell", () => {
		const unknown = "a-model-the-table-has-never-seen";
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 100, model: unknown, inputRef: 1}),
			row({pass: true, billed: 100, model: aliasedModel, inputRef: 2}),
		];
		const sc = buildScorecard({rows});
		// Normalize-only: no allowlist and no rejection, so the unrecognized model still reports.
		assert.strictEqual(cellFor(sc.cells, unknown).gradedRuns, 1);
		assert.strictEqual(sc.cells.length, 2);
	});

	it("a --baseline-model given as an alias matches the cell recorded under the canonical id", () => {
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 1000, model: canonicalId, inputRef: 1}),
			row({pass: true, billed: 400, model: "sonnet", inputRef: 2}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: aliasedModel}});
		// Pre-#5158 this matched no bucket and every netSaving came back null — fail-quiet.
		assert.strictEqual(sc.baseline?.model, canonicalId);
		assert.strictEqual(cellFor(sc.cells, "sonnet").netSaving, 600);
	});
});

describe("decodeReportInput — a rows file written before provenance existed still decodes", () => {
	it("reads an absent `provenance` as unrecorded rather than failing the file", () => {
		const legacy = JSON.stringify([
			{
				entry: {
					stage: "triage",
					inputRef: 1,
					label: {type: "bug", priority: "p0", status: "triaged"},
				},
				grade: {status: "pass"},
				spend: {_tag: "Reconstructed", spend: spend(100, "sonnet")},
			},
		]);
		const decoded = decodeReportInput(legacy);
		assert.isTrue(Result.isSuccess(decoded));
		if (!Result.isSuccess(decoded)) return;
		assert.deepStrictEqual(decoded.success[0]?.provenance, {model: null, arm: null});
		// …and it still scores exactly as it did before, off the transcript's model.
		assert.strictEqual(buildScorecard({rows: decoded.success}).cells[0]?.model, "sonnet");
	});
});

describe("report — the output carries no model recommendation, only evidence for #1576", () => {
	it("the scorecard and both rendered surfaces point at the decision and recommend nothing", () => {
		const rows: ReadonlyArray<RunRow> = [row({pass: true, billed: 100, model: "opus-4.8"})];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus-4.8"}});
		assert.strictEqual(sc.decisionRef, DECISION_POINTER);
		assert.strictEqual(DECISION_POINTER, 1576);

		const table = renderTable(sc);
		assert.include(table, "#1576");
		assert.include(table, "does not recommend or select a model");
		// No verdict/recommendation vocabulary leaks into the rendered evidence.
		assert.notMatch(
			table.toLowerCase(),
			/\brecommend(ed|s)?:\b|\buse (opus|sonnet)\b|\badopt (opus|sonnet)\b/,
		);

		const json = toJson(sc);
		const parsed = JSON.parse(json);
		assert.strictEqual(parsed.decisionRef, 1576);
		assert.include(parsed.framing, "does not recommend or select a model");
		// The JSON shape is stable + documented: no `recommendation`/`selected`/`winner` key.
		assert.notProperty(parsed, "recommendation");
		assert.notProperty(parsed, "selectedModel");
		assert.notProperty(parsed, "winner");
		assert.isArray(parsed.cells);
	});
});
