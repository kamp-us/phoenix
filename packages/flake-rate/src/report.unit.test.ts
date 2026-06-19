import {assert, describe, it} from "@effect/vitest";
import {checkBudget, flakeStats, flakeTrend, type WorkflowRun} from "./flake-rate.ts";
import {renderBudget, renderTrend} from "./report.ts";

const run = (over: Partial<WorkflowRun> & {runNumber: number}): WorkflowRun => ({
	runAttempt: 1,
	conclusion: "success",
	headBranch: "main",
	createdAt: "2026-06-19T00:00:00Z",
	...over,
});

describe("renderTrend", () => {
	it("renders one line per bucket with the percentage rate", () => {
		const trend = flakeTrend([run({runNumber: 1}), run({runNumber: 2, runAttempt: 2})], 1);
		const out = renderTrend(trend);
		assert.include(out, "bucket 0:");
		assert.include(out, "bucket 1:");
		assert.include(out, "100.0%");
	});

	it("reports an empty window explicitly", () => {
		assert.include(renderTrend([]), "no resolved runs");
	});
});

describe("renderBudget", () => {
	it("within budget renders a ✓ line and no alarm", () => {
		const verdict = checkBudget(flakeStats([run({runNumber: 1})]));
		const out = renderBudget(verdict);
		assert.include(out, "✓ within zero-flake budget");
		assert.notInclude(out, "BUDGET BLOWN");
	});

	it("a blown budget names the overage and the required follow-up", () => {
		const verdict = checkBudget(flakeStats([run({runNumber: 1, runAttempt: 2})]));
		const out = renderBudget(verdict);
		assert.include(out, "✗ BUDGET BLOWN");
		assert.include(out, "tests/FLAKE-INVENTORY.md");
		assert.include(out, "#765");
	});
});
