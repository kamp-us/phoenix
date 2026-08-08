import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {priceModelSwap, repairChurnCost, tokensFromTranscript} from "./repair-churn.ts";

/** Unwrap a success or fail the test loudly — keeps the arithmetic assertions terse. */
const value = <A>(r: Result.Result<A, unknown>): A => {
	if (Result.isSuccess(r)) return r.success;
	throw new Error("expected a success Result, got a failure");
};

describe("repairChurnCost — geometric expected-extra-cycles model", () => {
	it("a high-pass-rate model has near-zero churn", () => {
		// p = 0.95 ⇒ expected extra cycles = 0.05/0.95 ≈ 0.0526; churn a small fraction of one cycle.
		const cost = value(
			repairChurnCost({passRate: 0.95, tokensPerRun: 10_000, tokensPerRepairCycle: 8_000}),
		);
		assert.closeTo(cost.expectedExtraCycles, 0.05 / 0.95, 1e-9);
		assert.closeTo(cost.churnTokens, (0.05 / 0.95) * 8_000, 1e-6);
		assert.isBelow(cost.churnTokens, 500); // near-zero relative to the 10k per-run cost
	});

	it("the pass-rate=1 boundary has exactly zero extra cycles and zero churn", () => {
		const cost = value(
			repairChurnCost({passRate: 1, tokensPerRun: 10_000, tokensPerRepairCycle: 8_000}),
		);
		assert.strictEqual(cost.expectedExtraCycles, 0);
		assert.strictEqual(cost.churnTokens, 0);
		assert.strictEqual(cost.amortizedTokensPerRun, 10_000);
	});

	it("a pass-rate=0 model never passes: churn is +Infinity (never adopt)", () => {
		const cost = value(
			repairChurnCost({passRate: 0, tokensPerRun: 10_000, tokensPerRepairCycle: 8_000}),
		);
		assert.strictEqual(cost.expectedExtraCycles, Number.POSITIVE_INFINITY);
		assert.strictEqual(cost.churnTokens, Number.POSITIVE_INFINITY);
	});

	it("the (passRate=0, tokensPerRepairCycle=0) double boundary is never-adopt, not a hidden NaN", () => {
		// Infinity * 0 = NaN would slip past the `netSaving < 0` never-adopt check (`NaN < 0` is false).
		const cost = value(
			repairChurnCost({passRate: 0, tokensPerRun: 10_000, tokensPerRepairCycle: 0}),
		);
		assert.isFalse(Number.isNaN(cost.churnTokens));
		assert.strictEqual(cost.churnTokens, Number.POSITIVE_INFINITY);
		assert.strictEqual(cost.amortizedTokensPerRun, Number.POSITIVE_INFINITY);
		const pricing = value(
			priceModelSwap({
				baselineTokensPerRun: 12_000,
				candidate: {passRate: 0, tokensPerRun: 10_000, tokensPerRepairCycle: 0},
			}),
		);
		assert.isFalse(Number.isNaN(pricing.netSaving));
		assert.isBelow(pricing.netSaving, 0); // -Infinity < 0 — reads as never-adopt
	});

	it("a p=0.5 model forces exactly one expected extra cycle", () => {
		const cost = value(
			repairChurnCost({passRate: 0.5, tokensPerRun: 5_000, tokensPerRepairCycle: 10_000}),
		);
		assert.strictEqual(cost.expectedExtraCycles, 1); // (1-0.5)/0.5
		assert.strictEqual(cost.churnTokens, 10_000);
		assert.strictEqual(cost.amortizedTokensPerRun, 15_000);
	});
});

describe("repairChurnCost — invalid inputs are unrepresentable (typed failure, never NaN)", () => {
	it("rejects a passRate above 1", () => {
		const r = repairChurnCost({passRate: 1.5, tokensPerRun: 1, tokensPerRepairCycle: 1});
		assert.isTrue(Result.isFailure(r));
		if (Result.isFailure(r)) assert.strictEqual(r.failure._tag, "RepairChurnInputError");
	});

	it("rejects a negative passRate", () => {
		assert.isTrue(
			Result.isFailure(repairChurnCost({passRate: -0.1, tokensPerRun: 1, tokensPerRepairCycle: 1})),
		);
	});

	it("rejects a negative token count", () => {
		assert.isTrue(
			Result.isFailure(repairChurnCost({passRate: 0.9, tokensPerRun: -1, tokensPerRepairCycle: 1})),
		);
	});

	it("rejects a non-finite token count", () => {
		assert.isTrue(
			Result.isFailure(
				repairChurnCost({
					passRate: 0.9,
					tokensPerRun: Number.POSITIVE_INFINITY,
					tokensPerRepairCycle: 1,
				}),
			),
		);
	});
});

describe("priceModelSwap — net-token crossover (the epic's headline risk)", () => {
	it("a low-pass-rate cheaper model is net-negative: churn exceeds the per-run saving", () => {
		// Candidate is 3_000 tokens/run cheaper than the 12_000 baseline (a real per-run saving),
		// but at p=0.5 it forces one full 10_000-token repair cycle in expectation — churn (10_000)
		// exceeds the saving (3_000), so the swap LOSES tokens net.
		const pricing = value(
			priceModelSwap({
				baselineTokensPerRun: 12_000,
				candidate: {passRate: 0.5, tokensPerRun: 9_000, tokensPerRepairCycle: 10_000},
			}),
		);
		assert.strictEqual(pricing.perRunSaving, 3_000);
		assert.strictEqual(pricing.churn.churnTokens, 10_000);
		assert.isAbove(pricing.churn.churnTokens, pricing.perRunSaving); // churn ate the saving
		assert.isBelow(pricing.netSaving, 0); // net-negative crossover
		assert.strictEqual(pricing.netSaving, 3_000 - 10_000);
	});

	it("a high-pass-rate cheaper model stays net-positive: the saving survives the churn", () => {
		const pricing = value(
			priceModelSwap({
				baselineTokensPerRun: 12_000,
				candidate: {passRate: 0.98, tokensPerRun: 9_000, tokensPerRepairCycle: 10_000},
			}),
		);
		assert.strictEqual(pricing.perRunSaving, 3_000);
		assert.isBelow(pricing.churn.churnTokens, pricing.perRunSaving);
		assert.isAbove(pricing.netSaving, 0); // swap still saves tokens net
	});

	it("propagates a candidate input-validation failure", () => {
		const r = priceModelSwap({
			baselineTokensPerRun: 12_000,
			candidate: {passRate: 2, tokensPerRun: 9_000, tokensPerRepairCycle: 10_000},
		});
		assert.isTrue(Result.isFailure(r));
	});
});

describe("tokensFromTranscript — sourced from the token-spend reconstruction (ADR 0112 §2)", () => {
	const assistantLine = (usage: Record<string, number>): string =>
		JSON.stringify({type: "assistant", message: {role: "assistant", model: "claude", usage}});

	it("returns token-spend's four-component billed sum, not a new meter", () => {
		const transcript = [
			assistantLine({
				input_tokens: 10,
				cache_creation_input_tokens: 20,
				cache_read_input_tokens: 100,
				output_tokens: 5,
			}),
			assistantLine({
				input_tokens: 1,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 3,
				output_tokens: 4,
			}),
		].join("\n");
		// billed = (10+20+100+5) + (1+2+3+4) = 135 + 10 = 145
		assert.strictEqual(tokensFromTranscript(transcript), 145);
	});

	it("is total on a non-transcript body (skips unparseable lines, never throws)", () => {
		assert.strictEqual(tokensFromTranscript("not json at all {"), 0);
	});
});
