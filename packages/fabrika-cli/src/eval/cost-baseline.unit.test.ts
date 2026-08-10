import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import type {LedgerRow} from "../spend/ledger.ts";
import {
	buildCostBaseline,
	type CostBaseline,
	compareToBaseline,
	costBaselineToJson,
	decodeCostBaseline,
	foldLedgerRows,
	PHASE_2_DEFERRAL,
	renderBaselineComparison,
	renderCostBaseline,
} from "./cost-baseline.ts";

const value = <A>(r: Result.Result<A, unknown>): A => {
	if (Result.isSuccess(r)) return r.success;
	throw new Error("expected a success Result, got a failure");
};

const failure = <E>(r: Result.Result<unknown, E>): E => {
	if (Result.isFailure(r)) return r.failure;
	throw new Error("expected a failure Result, got a success");
};

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
	skillName: "fabrika-incident-corpus",
	stage: "build",
	caseId: 1,
	arm: "with-skill",
	model: "claude-opus-4-8",
	sessionId: "s-1",
	cliVersion: "2.1.227",
	recordedAt: "2026-08-10T23:00:00.000Z",
	spend: {
		_tag: "Reconstructed",
		spend: {
			input: 10,
			cacheCreate: 20,
			cacheRead: 60,
			output: 10,
			billed: 100,
			exCacheRead: 40,
			assistantTurns: 3,
			model: "claude-opus-4-8",
		},
	},
	...over,
});

const measured = (caseId: number, billed: number, exCacheRead: number): LedgerRow =>
	row({
		caseId,
		spend: {
			_tag: "Reconstructed",
			spend: {
				input: billed,
				cacheCreate: 0,
				cacheRead: 0,
				output: 0,
				billed,
				exCacheRead,
				assistantTurns: 1,
				model: "claude-opus-4-8",
			},
		},
	});

const pins = {
	suite: "v1",
	recordedAt: "2026-08-10T23:59:00.000Z",
	corpus: {
		path: "packages/fabrika-cli/src/eval/incident-corpus/ruled-keeps.json",
		revision: "abc1234",
		members: 66,
		pending: 1,
		cases: 17,
	},
	harness: {
		runner: "fabrika eval run",
		pluginDir: "claude-plugins/kampus-pipeline",
		arm: "with-skill",
		revision: "def5678",
	},
};

describe("foldLedgerRows — the fold is a measurement, never an average of two experiments", () => {
	it("sums billed and ex-cache-read and divides by the MEASURED run count", () => {
		const fold = value(foldLedgerRows([measured(1, 100, 40), measured(2, 300, 60)]));
		assert.strictEqual(fold.spend.billed, 400);
		assert.strictEqual(fold.spend.exCacheRead, 100);
		assert.strictEqual(fold.spend.billedPerRun, 200);
		assert.strictEqual(fold.spend.exCacheReadPerRun, 50);
		assert.strictEqual(fold.runs.cases, 2);
		assert.strictEqual(fold.runs.measured, 2);
		assert.strictEqual(fold.runs.unmeasured, 0);
	});

	it("an unmeasured run is counted but contributes nothing to the sums", () => {
		const fold = value(
			foldLedgerRows([
				measured(1, 100, 40),
				row({caseId: 2, spend: {_tag: "TranscriptMissing"}}),
				row({caseId: 3, spend: {_tag: "NoBilledTurns"}}),
			]),
		);
		assert.strictEqual(fold.spend.billed, 100);
		assert.strictEqual(fold.runs.measured, 1);
		assert.strictEqual(fold.runs.unmeasured, 2);
		assert.strictEqual(fold.spend.billedPerRun, 100);
	});

	it("zero rows is refused, never folded to a baseline of nothing (ADR 0092)", () => {
		assert.strictEqual(failure(foldLedgerRows([])).reason, "no-rows");
	});

	it("rows that all failed to measure are refused, never recorded as a free suite", () => {
		const only = [row({spend: {_tag: "TranscriptMissing"}}), row({spend: {_tag: "NoBilledTurns"}})];
		assert.strictEqual(failure(foldLedgerRows(only)).reason, "no-measured-runs");
	});

	it("two models in one fold is refused — a baseline names one model", () => {
		const mixed = [measured(1, 100, 40), row({caseId: 2, model: "claude-sonnet-4-5"})];
		assert.strictEqual(failure(foldLedgerRows(mixed)).reason, "mixed-model");
	});

	it("an alias and its canonical id are ONE model, not two", () => {
		const aliased = [measured(1, 100, 40), row({caseId: 2, model: "opus"})];
		assert.strictEqual(value(foldLedgerRows(aliased)).model, "claude-opus-4-8");
	});

	it("two CLI versions in one fold is refused — the #4637 pin names one", () => {
		const mixed = [measured(1, 100, 40), row({caseId: 2, cliVersion: "2.0.0"})];
		assert.strictEqual(failure(foldLedgerRows(mixed)).reason, "mixed-cli-version");
	});
});

describe("buildCostBaseline — the pins the artifact carries", () => {
	it("carries the corpus revision, run count, model, CLI and harness version", () => {
		const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));
		assert.strictEqual(baseline.corpus.revision, "abc1234");
		assert.strictEqual(baseline.corpus.members, 66);
		assert.strictEqual(baseline.corpus.pending, 1);
		assert.strictEqual(baseline.runs.measured, 1);
		assert.strictEqual(baseline.harness.model, "claude-opus-4-8");
		assert.strictEqual(baseline.harness.cliVersion, "2.1.227");
		assert.strictEqual(baseline.harness.revision, "def5678");
	});

	it("records the v1 adapter — the plugin dir that made this the v1 arm", () => {
		const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));
		assert.strictEqual(baseline.harness.pluginDir, "claude-plugins/kampus-pipeline");
		assert.strictEqual(baseline.harness.runner, "fabrika eval run");
	});

	it("states the phase-2 deferral and introduces no per-stage budget", () => {
		const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));
		assert.strictEqual(baseline.phase2, PHASE_2_DEFERRAL);
		// The whole artifact is one corpus-level total; nothing in it is keyed by stage.
		assert.notInclude(Object.keys(baseline), "budgets");
		assert.notInclude(costBaselineToJson(baseline), "perStageBudget");
	});

	it("round-trips through its own decoder", () => {
		const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));
		const back = value(decodeCostBaseline(costBaselineToJson(baseline)));
		assert.deepStrictEqual(back, baseline);
	});
});

describe("decodeCostBaseline — total", () => {
	it("malformed JSON is a typed failure, never a throw", () => {
		assert.strictEqual(failure(decodeCostBaseline("{ not json")).reason, "malformed-json");
	});

	it("a baseline missing its phase-2 statement does not decode", () => {
		const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));
		const {phase2: _dropped, ...without} = baseline;
		assert.strictEqual(
			failure(decodeCostBaseline(JSON.stringify(without))).reason,
			"schema-mismatch",
		);
	});
});

describe("compareToBaseline — the phase-1 ceiling question", () => {
	const baseline: CostBaseline = value(
		buildCostBaseline({rows: [measured(1, 300, 100), measured(2, 300, 100)], pins}),
	);

	it("cheaper on the same corpus is at-or-below", () => {
		const candidate = value(foldLedgerRows([measured(1, 100, 40), measured(2, 100, 40)]));
		const verdict = compareToBaseline(baseline, candidate);
		assert.strictEqual(verdict.verdict, "at-or-below");
		assert.strictEqual(verdict.deltaBilled, -400);
	});

	it("an exact tie is at-or-below — the ruled bar is ≤, not <", () => {
		const candidate = value(foldLedgerRows([measured(1, 300, 100), measured(2, 300, 100)]));
		assert.strictEqual(compareToBaseline(baseline, candidate).verdict, "at-or-below");
	});

	it("dearer on the same corpus is above", () => {
		const candidate = value(foldLedgerRows([measured(1, 500, 100), measured(2, 500, 100)]));
		const verdict = compareToBaseline(baseline, candidate);
		assert.strictEqual(verdict.verdict, "above");
		assert.strictEqual(verdict.deltaBilled, 400);
	});

	it("a different case count is INCOMPARABLE, never a pass on a cheaper total", () => {
		const candidate = value(foldLedgerRows([measured(1, 1, 1)]));
		const verdict = compareToBaseline(baseline, candidate);
		assert.strictEqual(verdict.verdict, "incomparable");
		assert.strictEqual(verdict.deltaBilled, null);
		assert.include(verdict.reason, "case");
	});

	it("a different model is INCOMPARABLE — a cost ceiling holds one model fixed", () => {
		const other = [measured(1, 1, 1), measured(2, 1, 1)].map((r) => ({
			...r,
			model: "claude-sonnet-4-5",
		}));
		const verdict = compareToBaseline(baseline, value(foldLedgerRows(other)));
		assert.strictEqual(verdict.verdict, "incomparable");
		assert.include(verdict.reason, "model");
	});

	it("every verdict states its reason", () => {
		const candidate = value(foldLedgerRows([measured(1, 100, 40), measured(2, 100, 40)]));
		assert.isAbove(compareToBaseline(baseline, candidate).reason.length, 0);
	});
});

describe("the rendered surfaces", () => {
	const baseline = value(buildCostBaseline({rows: [measured(1, 100, 40)], pins}));

	it("the baseline table shows every pin a later comparison needs", () => {
		const table = renderCostBaseline(baseline);
		for (const pin of ["abc1234", "def5678", "claude-opus-4-8", "2.1.227", "17"]) {
			assert.include(table, pin);
		}
		assert.include(table, PHASE_2_DEFERRAL);
	});

	it("the comparison leads with the verdict", () => {
		const candidate = value(foldLedgerRows([measured(1, 10, 5)]));
		assert.include(
			renderBaselineComparison(compareToBaseline(baseline, candidate)).split("\n")[0],
			"AT-OR-BELOW",
		);
	});
});
