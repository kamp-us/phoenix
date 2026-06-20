import {assert, describe, it} from "@effect/vitest";
import {
	checkBudget,
	checkBudgetWithDiscount,
	flakeStats,
	flakeTrend,
	type WorkflowRun,
} from "./flake-rate.ts";
import {renderBudget, renderDiscountedBudget, renderTrend} from "./report.ts";

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

describe("renderDiscountedBudget", () => {
	const fix = {ref: "fate-live prependNode (PR #810)", fixedAt: "2026-06-20T06:00:00Z"};

	it("names the discounted run + the fix, and clears the budget (the #812 case)", () => {
		const runs = [
			run({runNumber: 1, createdAt: "2026-06-19T01:00:00Z"}),
			run({runNumber: 873, runAttempt: 2, createdAt: "2026-06-19T02:00:00Z"}),
		];
		const out = renderDiscountedBudget(checkBudgetWithDiscount(runs, [fix]));
		assert.include(out, "discounted 1 rerun-to-green as inventory-fixed");
		assert.include(out, "run #873");
		assert.include(out, "fate-live prependNode (PR #810)");
		assert.include(out, "✓ within zero-flake budget");
		assert.notInclude(out, "BUDGET BLOWN");
	});

	it("shows BUDGET BLOWN for an un-recorded flake (no discount line)", () => {
		const runs = [run({runNumber: 5, runAttempt: 2, createdAt: "2026-06-19T02:00:00Z"})];
		const out = renderDiscountedBudget(checkBudgetWithDiscount(runs, []));
		assert.notInclude(out, "discounted");
		assert.include(out, "✗ BUDGET BLOWN");
	});

	it("a post-fix recurrence is not discounted and still blows the budget", () => {
		const runs = [run({runNumber: 9, runAttempt: 2, createdAt: "2026-06-20T09:00:00Z"})];
		const out = renderDiscountedBudget(checkBudgetWithDiscount(runs, [fix]));
		assert.notInclude(out, "discounted");
		assert.include(out, "✗ BUDGET BLOWN");
	});
});
