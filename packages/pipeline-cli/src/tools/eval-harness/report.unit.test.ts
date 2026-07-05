import {assert, describe, it} from "@effect/vitest";
import type {StageSpend} from "../token-spend/token-spend.ts";
import type {CorpusEntry} from "./corpus.ts";
import {
	buildScorecard,
	DECISION_POINTER,
	renderTable,
	type ScorecardCell,
	toJson,
} from "./report.ts";
import type {RunRow} from "./runner.ts";

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

// One graded run row: a pass/fail grade + a reconstructed spend at `billed` tokens on `model`.
const row = (opts: {pass: boolean; billed: number; model: string; inputRef?: number}): RunRow => ({
	entry: triageEntry(opts.inputRef ?? 1),
	grade: opts.pass
		? {status: "pass"}
		: {status: "fail", mismatch: {_tag: "MalformedArtifact", reason: "x"}},
	spend: {_tag: "Reconstructed", spend: spend(opts.billed, opts.model)},
});

const missingSpendRow = (opts: {pass: boolean; inputRef?: number}): RunRow => ({
	entry: triageEntry(opts.inputRef ?? 1),
	grade: opts.pass
		? {status: "pass"}
		: {status: "fail", mismatch: {_tag: "MalformedArtifact", reason: "x"}},
	spend: {_tag: "TranscriptMissing"},
});

const cellFor = (cells: ReadonlyArray<ScorecardCell>, model: string | null): ScorecardCell => {
	const found = cells.find((c) => c.model === model);
	assert.isDefined(found, `expected a cell for model ${model}`);
	return found as ScorecardCell;
};

describe("buildScorecard — single (stage × model)", () => {
	it("computes pass-rate and mean per-run billed + ex-cache-read spend for one cell", () => {
		// 3 runs, 2 pass ⇒ pass-rate 2/3; billed 100/200/300 ⇒ mean 200.
		const rows: ReadonlyArray<RunRow> = [
			row({pass: true, billed: 100, model: "opus"}),
			row({pass: true, billed: 200, model: "opus"}),
			row({pass: false, billed: 300, model: "opus"}),
		];
		const sc = buildScorecard({rows});
		assert.strictEqual(sc.cells.length, 1);
		const cell = cellFor(sc.cells, "opus");
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
			row({pass: true, billed: 100, model: "opus"}),
			missingSpendRow({pass: true}),
		];
		const sc = buildScorecard({rows});
		// Both runs land in the same (stage × model) cell — the missing-transcript run has model null,
		// so it buckets separately. Assert the two are distinct and both counted.
		const opusCell = cellFor(sc.cells, "opus");
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
			row({pass: true, billed: 1000, model: "opus", inputRef: 1}),
			row({pass: true, billed: 400, model: "sonnet", inputRef: 2}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus"}});
		assert.isNotNull(sc.baseline);
		assert.strictEqual(sc.baseline?.model, "opus");

		const opus = cellFor(sc.cells, "opus");
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
			row({pass: true, billed: 1000, model: "opus", inputRef: 1}),
			row({pass: true, billed: 700, model: "sonnet", inputRef: 2}),
			row({pass: false, billed: 700, model: "sonnet", inputRef: 3}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus"}});
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
			row({pass: true, billed: 1000, model: "opus", inputRef: 1}),
			row({pass: false, billed: 10, model: "flaky", inputRef: 2}),
		];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus"}});
		const flaky = cellFor(sc.cells, "flaky");
		assert.strictEqual(flaky.passRate, 0);
		assert.strictEqual(flaky.churn?.churnTokens, Number.POSITIVE_INFINITY);
		// netSaving = 1000 − Infinity = −Infinity: not a finite number, so not flagged net-negative,
		// but the amortized cost is unbounded (rendered as -∞ saving) — never adopt.
		assert.strictEqual(flaky.netSaving, Number.NEGATIVE_INFINITY);
		assert.isFalse(flaky.netNegative);
	});
});

describe("report — the output carries no model recommendation, only evidence for #1576", () => {
	it("the scorecard and both rendered surfaces point at the decision and recommend nothing", () => {
		const rows: ReadonlyArray<RunRow> = [row({pass: true, billed: 100, model: "opus"})];
		const sc = buildScorecard({rows, baseline: {stage: "triage", model: "opus"}});
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
