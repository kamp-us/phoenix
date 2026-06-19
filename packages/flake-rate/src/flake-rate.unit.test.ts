import {assert, describe, it} from "@effect/vitest";
import {
	checkBudget,
	classifyRun,
	flakeStats,
	flakeTrend,
	isFlake,
	type WorkflowRun,
	ZERO_FLAKE_BUDGET,
} from "./flake-rate.ts";

const run = (over: Partial<WorkflowRun> & {runNumber: number}): WorkflowRun => ({
	runAttempt: 1,
	conclusion: "success",
	headBranch: "main",
	createdAt: "2026-06-19T00:00:00Z",
	...over,
});

describe("classifyRun", () => {
	it("attempt 1 + success is first-try-green", () => {
		assert.strictEqual(classifyRun(run({runNumber: 1, runAttempt: 1})), "first-try-green");
	});

	it("attempt > 1 + success is rerun-to-green (the laundered flake)", () => {
		assert.strictEqual(classifyRun(run({runNumber: 1, runAttempt: 2})), "rerun-to-green");
	});

	it("a failure is failed regardless of attempt", () => {
		assert.strictEqual(classifyRun(run({runNumber: 1, conclusion: "failure"})), "failed");
		assert.strictEqual(
			classifyRun(run({runNumber: 1, runAttempt: 3, conclusion: "failure"})),
			"failed",
		);
	});

	it("timed_out is failed", () => {
		assert.strictEqual(classifyRun(run({runNumber: 1, conclusion: "timed_out"})), "failed");
	});

	it("an in-progress (null conclusion) or cancelled run is unresolved", () => {
		assert.strictEqual(classifyRun(run({runNumber: 1, conclusion: null})), "unresolved");
		assert.strictEqual(classifyRun(run({runNumber: 1, conclusion: "cancelled"})), "unresolved");
	});
});

describe("isFlake", () => {
	it("is true only for a rerun-to-green run", () => {
		assert.isTrue(isFlake(run({runNumber: 1, runAttempt: 2})));
		assert.isFalse(isFlake(run({runNumber: 2, runAttempt: 1})));
		assert.isFalse(isFlake(run({runNumber: 3, runAttempt: 2, conclusion: "failure"})));
	});
});

describe("flakeStats", () => {
	it("rate is rerun-to-green over runs that reached green; failures excluded from denominator", () => {
		const runs = [
			run({runNumber: 1, runAttempt: 1}),
			run({runNumber: 2, runAttempt: 1}),
			run({runNumber: 3, runAttempt: 2}), // laundered flake
			run({runNumber: 4, conclusion: "failure"}),
			run({runNumber: 5, conclusion: null}), // unresolved, ignored
		];
		const stats = flakeStats(runs);
		assert.strictEqual(stats.firstTryGreen, 2);
		assert.strictEqual(stats.rerunToGreen, 1);
		assert.strictEqual(stats.failed, 1);
		assert.strictEqual(stats.total, 4);
		// 1 rerun-to-green / 3 green
		assert.closeTo(stats.flakeRate, 1 / 3, 1e-9);
	});

	it("rate is 0 when no run reached green (no divide-by-zero)", () => {
		const stats = flakeStats([run({runNumber: 1, conclusion: "failure"})]);
		assert.strictEqual(stats.flakeRate, 0);
		assert.strictEqual(stats.failed, 1);
	});

	it("an empty window is all zeros", () => {
		const stats = flakeStats([]);
		assert.deepStrictEqual(stats, {
			total: 0,
			firstTryGreen: 0,
			rerunToGreen: 0,
			failed: 0,
			flakeRate: 0,
		});
	});
});

describe("flakeTrend", () => {
	it("orders runs by createdAt ascending and buckets them oldest → newest", () => {
		const runs = [
			run({runNumber: 3, createdAt: "2026-06-19T03:00:00Z", runAttempt: 2}), // newest = a flake
			run({runNumber: 1, createdAt: "2026-06-19T01:00:00Z"}),
			run({runNumber: 2, createdAt: "2026-06-19T02:00:00Z"}),
		];
		const trend = flakeTrend(runs, 2);
		assert.strictEqual(trend.length, 2);
		// bucket 0 = two oldest, both first-try-green
		assert.strictEqual(trend[0]?.stats.rerunToGreen, 0);
		// bucket 1 = newest run, the flake — a rising tail is visible
		assert.strictEqual(trend[1]?.stats.rerunToGreen, 1);
		assert.strictEqual(trend[1]?.stats.flakeRate, 1);
	});

	it("keeps a trailing partial bucket (the live edge of the window)", () => {
		const runs = [
			run({runNumber: 1, createdAt: "2026-06-19T01:00:00Z"}),
			run({runNumber: 2, createdAt: "2026-06-19T02:00:00Z"}),
			run({runNumber: 3, createdAt: "2026-06-19T03:00:00Z"}),
		];
		const trend = flakeTrend(runs, 2);
		assert.strictEqual(trend.length, 2);
		assert.strictEqual(trend[1]?.stats.total, 1);
	});

	it("an empty window yields no buckets", () => {
		assert.strictEqual(flakeTrend([], 5).length, 0);
	});

	it("rejects a bucketSize below 1", () => {
		assert.throws(() => flakeTrend([run({runNumber: 1})], 0), RangeError);
	});
});

describe("checkBudget", () => {
	it("zero-flake budget is within budget on a clean window", () => {
		const stats = flakeStats([run({runNumber: 1}), run({runNumber: 2})]);
		const verdict = checkBudget(stats, ZERO_FLAKE_BUDGET);
		assert.isTrue(verdict.withinBudget);
		assert.strictEqual(verdict.overBy, 0);
	});

	it("a single laundered flake blows the zero-flake budget (self-evident alarm)", () => {
		const stats = flakeStats([run({runNumber: 1}), run({runNumber: 2, runAttempt: 2})]);
		const verdict = checkBudget(stats, ZERO_FLAKE_BUDGET);
		assert.isFalse(verdict.withinBudget);
		assert.strictEqual(verdict.overBy, 1);
	});

	it("defaults to the zero-flake budget", () => {
		const stats = flakeStats([run({runNumber: 1, runAttempt: 2})]);
		assert.isFalse(checkBudget(stats).withinBudget);
	});

	it("honors a non-zero budget for overage math", () => {
		const stats = flakeStats([
			run({runNumber: 1, runAttempt: 2}),
			run({runNumber: 2, runAttempt: 2}),
			run({runNumber: 3, runAttempt: 2}),
		]);
		const verdict = checkBudget(stats, {maxRerunToGreen: 1});
		assert.isFalse(verdict.withinBudget);
		assert.strictEqual(verdict.overBy, 2);
	});
});
