import {assert, describe, it} from "@effect/vitest";
import {formatSessionCost} from "./session-cost.ts";

describe("formatSessionCost — per-session cost/token renderer", () => {
	it("formats dollars and tokens together", () => {
		assert.strictEqual(
			formatSessionCost({totalCostUsd: 1.234, totalTokens: 45_000}),
			"$1.23 · 45.0K tok",
		);
	});

	it("shows sub-cent spend at 4 dp so an early session isn't '$0.00 free'", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: 0.0042}), "$0.0042");
	});

	it("formats millions of tokens", () => {
		assert.strictEqual(formatSessionCost({totalTokens: 2_500_000}), "2.5M tok");
	});

	it("formats small token counts raw", () => {
		assert.strictEqual(formatSessionCost({totalTokens: 800}), "800 tok");
	});

	it("prefixes the model when present", () => {
		assert.strictEqual(
			formatSessionCost({totalCostUsd: 0.5, totalTokens: 12_000, model: "claude-fable-5"}),
			"claude-fable-5 · $0.50 · 12.0K tok",
		);
	});

	it("degrades to 'cost n/a' on a payload with no figures (no crash, no blank line)", () => {
		assert.strictEqual(formatSessionCost({}), "cost n/a");
		assert.strictEqual(formatSessionCost({totalCostUsd: null, totalTokens: null}), "cost n/a");
	});

	it("ignores non-finite / negative figures rather than rendering NaN", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: Number.NaN, totalTokens: -5}), "cost n/a");
	});

	it("shows just the cost when tokens are absent", () => {
		assert.strictEqual(formatSessionCost({totalCostUsd: 3}), "$3.00");
	});
});
