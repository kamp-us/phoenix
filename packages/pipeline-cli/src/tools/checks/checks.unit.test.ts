import {assert, describe, it} from "@effect/vitest";
import {type CheckRun, isFailing, latestPerContext, rollupChecks} from "./checks.ts";

let nextId = 1;
const run = (over: Partial<CheckRun> & {readonly name: string}): CheckRun => ({
	conclusion: "success",
	startedAt: "2026-07-22T05:00:00Z",
	completedAt: "2026-07-22T05:05:00Z",
	id: nextId++,
	...over,
});

const noStatuses = {state: "pending", totalCount: 0} as const;

describe("latestPerContext — one current run per context name", () => {
	it("keeps the most recent run and drops the superseded ones", () => {
		const latest = latestPerContext([
			run({name: "ci-required", conclusion: "failure", startedAt: "2026-07-22T05:50:04Z"}),
			run({name: "ci-required", conclusion: "success", startedAt: "2026-07-22T06:21:26Z"}),
			run({name: "ci-required", conclusion: "failure", startedAt: "2026-07-22T06:09:51Z"}),
		]);
		assert.deepStrictEqual(
			latest.map((c) => [c.name, c.conclusion]),
			[["ci-required", "success"]],
		);
	});

	it("falls back to the run id when start times tie or are absent", () => {
		const latest = latestPerContext([
			run({name: "e2e", conclusion: "failure", startedAt: null, id: 10}),
			run({name: "e2e", conclusion: "success", startedAt: null, id: 11}),
		]);
		assert.deepStrictEqual(latest[0]?.conclusion, "success");
	});

	it("is order-independent and name-sorted", () => {
		const forward = latestPerContext([
			run({name: "b", startedAt: "2026-07-22T01:00:00Z"}),
			run({name: "a", conclusion: "failure", startedAt: "2026-07-22T01:00:00Z"}),
			run({name: "a", startedAt: "2026-07-22T02:00:00Z"}),
		]);
		const reversed = latestPerContext([
			run({name: "a", startedAt: "2026-07-22T02:00:00Z"}),
			run({name: "a", conclusion: "failure", startedAt: "2026-07-22T01:00:00Z"}),
			run({name: "b", startedAt: "2026-07-22T01:00:00Z"}),
		]);
		assert.deepStrictEqual(
			forward.map((c) => [c.name, c.conclusion]),
			[
				["a", "success"],
				["b", "success"],
			],
		);
		assert.deepStrictEqual(
			forward.map((c) => [c.name, c.conclusion]),
			reversed.map((c) => [c.name, c.conclusion]),
		);
	});

	it("keeps distinct contexts apart", () => {
		const latest = latestPerContext([run({name: "lint"}), run({name: "typecheck"})]);
		assert.deepStrictEqual(
			latest.map((c) => c.name),
			["lint", "typecheck"],
		);
	});
});

describe("isFailing — only an explicit failing conclusion is red", () => {
	const table: ReadonlyArray<readonly [string | null, boolean]> = [
		["failure", true],
		["timed_out", true],
		["cancelled", true],
		["action_required", true],
		["startup_failure", true],
		["success", false],
		["neutral", false],
		["skipped", false],
		["stale", false],
		[null, false],
	];
	for (const [conclusion, expected] of table) {
		it(`${conclusion ?? "null"} ⇒ ${expected ? "failing" : "not failing"}`, () => {
			assert.strictEqual(isFailing(run({name: "x", conclusion})), expected);
		});
	}
});

describe("rollupChecks — the head verdict, computed latest-per-context", () => {
	// The #3762 defect case, from PR #3733's real head: an earlier RED for a context whose
	// latest run is green must resolve GREEN, not red.
	it("a superseded red with a green latest is GREEN", () => {
		const rollup = rollupChecks({
			checkRuns: [
				run({name: "ci-required", conclusion: "failure", startedAt: "2026-07-22T05:50:04Z"}),
				run({name: "ci-required", conclusion: "failure", startedAt: "2026-07-22T06:09:51Z"}),
				run({name: "ci-required", conclusion: "success", startedAt: "2026-07-22T06:21:26Z"}),
				run({name: "e2e", conclusion: "failure", startedAt: "2026-07-22T05:58:40Z"}),
				run({name: "e2e", conclusion: "skipped", startedAt: "2026-07-22T06:21:23Z"}),
			],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "green");
		assert.deepStrictEqual(rollup.failing, []);
	});

	it("a currently-failing context is RED and is reported by name", () => {
		const rollup = rollupChecks({
			checkRuns: [
				run({name: "ci-required", conclusion: "success", startedAt: "2026-07-22T05:00:00Z"}),
				run({name: "ci-required", conclusion: "failure", startedAt: "2026-07-22T06:00:00Z"}),
			],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "red");
		assert.deepStrictEqual(
			rollup.failing.map((c) => c.name),
			["ci-required"],
		);
	});

	it("red wins over a still-running sibling context", () => {
		const rollup = rollupChecks({
			checkRuns: [
				run({name: "lint", conclusion: "failure"}),
				run({name: "e2e", conclusion: null, completedAt: null}),
			],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "red");
	});

	it("an unconcluded context is PENDING, never green", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "lint"}), run({name: "e2e", conclusion: null, completedAt: null})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "pending");
		assert.deepStrictEqual(
			rollup.running.map((c) => c.name),
			["e2e"],
		);
	});

	it("neutral and skipped latest runs are green", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "a", conclusion: "neutral"}), run({name: "b", conclusion: "skipped"})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "green");
	});

	// The combined-status endpoint reports `pending` for a commit with zero statuses, which is
	// exactly phoenix's shape — reading that state unguarded pins every head at pending forever.
	it("a zero-status combined `pending` does not hold a green head at pending", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "ci-required"})],
			combinedStatus: {state: "pending", totalCount: 0},
		});
		assert.strictEqual(rollup.conclusion, "green");
	});

	it("a real failing commit status reds a head whose check runs are all green", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "ci-required"})],
			combinedStatus: {state: "failure", totalCount: 1},
		});
		assert.strictEqual(rollup.conclusion, "red");
	});

	it("a real pending commit status holds a head at pending", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "ci-required"})],
			combinedStatus: {state: "pending", totalCount: 2},
		});
		assert.strictEqual(rollup.conclusion, "pending");
	});

	it("no signal at all is PENDING, not an unearned green", () => {
		const rollup = rollupChecks({checkRuns: [], combinedStatus: noStatuses});
		assert.strictEqual(rollup.conclusion, "pending");
	});
});
