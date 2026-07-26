import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {
	type CheckRun,
	type CheckSuite,
	isFailing,
	isWedged,
	latestPerContext,
	rollupChecks,
} from "./checks.ts";
import {FAILCLOSED_STEP3_ENTRY_TEST, parseStep3EntryTest} from "./step3-contract.ts";

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

const unconcluded = (over: {readonly name: string; readonly status?: string | null}): CheckRun =>
	run({conclusion: null, completedAt: null, startedAt: null, ...over});

describe("isWedged — stranded in the queue, on positive evidence of both tells", () => {
	it("queued with no start time is wedged", () => {
		assert.strictEqual(isWedged(unconcluded({name: "fanout-guard", status: "queued"})), true);
	});

	it("queued but already started is running, not wedged", () => {
		assert.strictEqual(
			isWedged(
				run({
					name: "fanout-guard",
					conclusion: null,
					completedAt: null,
					status: "queued",
					startedAt: "2026-07-25T05:00:00Z",
				}),
			),
			false,
		);
	});

	it("an absent status is indeterminate, so never wedged", () => {
		assert.strictEqual(isWedged(unconcluded({name: "e2e"})), false);
	});

	it("a concluded run is never wedged", () => {
		assert.strictEqual(isWedged(run({name: "lint", status: "completed"})), false);
	});
});

describe("rollupChecks — running and wedged are told apart, both still pending", () => {
	// The ~2.5h `fanout-guard` wedge (#3999): a queued run with a null start time never starts,
	// so waiting it out is futile — but it is still not green, so the gate stays fail-closed.
	it("a wedged context is PENDING and reported as wedged, not as running", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "lint"}), unconcluded({name: "fanout-guard", status: "queued"})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "pending");
		assert.deepStrictEqual(
			rollup.wedged.map((c) => c.name),
			["fanout-guard"],
		);
		assert.deepStrictEqual(rollup.running, []);
	});

	it("an in-flight context is running, not wedged", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "e2e", conclusion: null, completedAt: null, status: "in_progress"})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "pending");
		assert.deepStrictEqual(
			rollup.running.map((c) => c.name),
			["e2e"],
		);
		assert.deepStrictEqual(rollup.wedged, []);
	});

	it("a head that is both running and wedged reports both sets", () => {
		const rollup = rollupChecks({
			checkRuns: [
				run({name: "e2e", conclusion: null, completedAt: null, status: "in_progress"}),
				unconcluded({name: "fanout-guard", status: "queued"}),
			],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(rollup.conclusion, "pending");
		assert.deepStrictEqual(
			rollup.running.map((c) => c.name),
			["e2e"],
		);
		assert.deepStrictEqual(
			rollup.wedged.map((c) => c.name),
			["fanout-guard"],
		);
	});
});

const suite = (over: Partial<CheckSuite> & {readonly appSlug: string}): CheckSuite => ({
	id: nextId++,
	status: "queued",
	latestCheckRunsCount: 0,
	...over,
});

describe("rollupChecks — a check suite with zero attached runs is not pending", () => {
	// PR #3988's head: every check run completed, while three third-party suites sat `queued`
	// with no runs attached. The head is green; the inert suites are reported, never counted.
	it("the PR #3988 shape — all runs completed, three zero-run queued suites — is GREEN", () => {
		const rollup = rollupChecks({
			checkRuns: [
				run({name: "detect changed areas"}),
				run({name: "ci-required"}),
				run({name: "e2e", conclusion: "skipped"}),
			],
			combinedStatus: noStatuses,
			suites: [
				suite({appSlug: "vercel"}),
				suite({appSlug: "sentry"}),
				suite({appSlug: "cloudflare-workers-and-pages"}),
			],
		});
		assert.strictEqual(rollup.conclusion, "green");
		assert.deepStrictEqual(
			rollup.inertSuites.map((s) => s.appSlug),
			["vercel", "sentry", "cloudflare-workers-and-pages"],
		);
	});

	it("a suite that attached runs is not inert, and still adds no pending-ness of its own", () => {
		const rollup = rollupChecks({
			checkRuns: [run({name: "ci-required"})],
			combinedStatus: noStatuses,
			suites: [suite({appSlug: "github-actions", status: "completed", latestCheckRunsCount: 1})],
		});
		assert.strictEqual(rollup.conclusion, "green");
		assert.deepStrictEqual(rollup.inertSuites, []);
	});

	it("suites never override the runs: a wedged run still holds the head pending", () => {
		const rollup = rollupChecks({
			checkRuns: [unconcluded({name: "fanout-guard", status: "queued"})],
			combinedStatus: noStatuses,
			suites: [suite({appSlug: "vercel"})],
		});
		assert.strictEqual(rollup.conclusion, "pending");
	});

	it("omitting suites entirely changes no verdict", () => {
		const checkRuns = [run({name: "ci-required"})];
		assert.strictEqual(rollupChecks({checkRuns, combinedStatus: noStatuses}).conclusion, "green");
	});
});

// The live skill — the single source for Step 3's branch order. Read repo-relative off this
// file's own location so it resolves identically in CI and in a worktree.
const SHIP_IT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../..",
	"claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md",
);
const SHIP_IT_TEXT = readFileSync(SHIP_IT_PATH, "utf8");
const LIVE_STEP3_ENTRY = parseStep3EntryTest(SHIP_IT_TEXT);

/**
 * A test-local mirror of ship-it Step 3's classification order, so the branch the shipper takes on
 * a given rollup is executable rather than only prose
 * (`claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md`, Step 3).
 *
 * Branch 2 is not hand-copied: its predicate is the field set the skill's own entry test reads,
 * parsed off that file. Editing the skill's entry test back to the rollup colour resolves those
 * fields away, and the two regression cases below stop settle-polling — the drift goes red instead
 * of passing over the defect the mirror exists to guard (#4054).
 */
type Step3Branch = "heal-ci" | "empty-set" | "settle-poll" | "proceed";

const isInformational = (name: string): boolean =>
	name === "deploy (web)" || name.startsWith("cleanup (web,");

// The rollup's array-valued fields, by the name a jq binding in the skill would use. A field the
// skill names that is NOT one of these (`conclusion`, the colour) resolves to no set at all.
const ROLLUP_SETS: Readonly<
	Record<string, (rollup: ReturnType<typeof rollupChecks>) => ReadonlyArray<CheckRun>>
> = {
	failing: (rollup) => rollup.failing,
	latest: (rollup) => rollup.latest,
	running: (rollup) => rollup.running,
	wedged: (rollup) => rollup.wedged,
};

const skillSaysPending = (rollup: ReturnType<typeof rollupChecks>): boolean =>
	LIVE_STEP3_ENTRY.fields.some((field) => (ROLLUP_SETS[field]?.(rollup).length ?? 0) > 0);

const step3Branch = (rollup: ReturnType<typeof rollupChecks>): Step3Branch => {
	if (rollup.failing.some((c) => !isInformational(c.name))) return "heal-ci"; // 1: gating red
	if (rollup.latest.length === 0) return "empty-set"; // 1b: zero contexts
	if (skillSaysPending(rollup)) return "settle-poll"; // 2: the pending SETS, per the skill
	return "proceed"; // 4: every gating check is green
};

describe("ship-it Step 3's branch-2 entry test, read off the live SKILL.md", () => {
	it("reads the pending sets — the rollup's running/wedged arrays", () => {
		assert.deepStrictEqual(LIVE_STEP3_ENTRY.fields, ["running", "wedged"]);
	});

	it("binds no rollup colour: `.conclusion` is an aggregate in which red wins over pending", () => {
		assert.notInclude(LIVE_STEP3_ENTRY.condition, "conclusion");
		assert.notInclude(LIVE_STEP3_ENTRY.fields, "conclusion");
	});

	it("the #3999 drift is caught: an entry test rewritten to the colour resolves no pending set", () => {
		const drifted = SHIP_IT_TEXT.replace(LIVE_STEP3_ENTRY.condition, '[ "$CI_STATE" = pending ]');
		assert.notStrictEqual(drifted, SHIP_IT_TEXT);
		assert.deepStrictEqual(parseStep3EntryTest(drifted).fields, []);
	});

	it("fails closed on a Step 3 it cannot read, rather than resolving a green-looking empty", () => {
		assert.deepStrictEqual(parseStep3EntryTest(""), FAILCLOSED_STEP3_ENTRY_TEST);
		assert.deepStrictEqual(FAILCLOSED_STEP3_ENTRY_TEST.fields, []);
	});
});

describe("ship-it Step 3 branch 2 — an informational red never masks an unfinished check", () => {
	const informationalRedPlus = (unfinished: CheckRun, informationalRed: string) =>
		rollupChecks({
			checkRuns: [
				run({name: informationalRed, conclusion: "failure"}),
				run({name: "lint"}),
				unfinished,
			],
			combinedStatus: noStatuses,
		});

	it("informational red + running: the colour is red, yet the head must still settle-poll", () => {
		const rollup = informationalRedPlus(
			run({name: "e2e", conclusion: null, completedAt: null, status: "in_progress"}),
			"deploy (web)",
		);
		assert.strictEqual(rollup.conclusion, "red"); // the trap: red wins over pending in the colour
		assert.deepStrictEqual(
			rollup.running.map((c) => c.name),
			["e2e"],
		);
		assert.strictEqual(step3Branch(rollup), "settle-poll");
	});

	it("informational red + wedged: the #3999 state refuses, it does not enqueue", () => {
		const rollup = informationalRedPlus(
			unconcluded({name: "fanout-guard", status: "queued"}),
			"cleanup (web, pr-1)",
		);
		assert.strictEqual(rollup.conclusion, "red");
		assert.deepStrictEqual(
			rollup.wedged.map((c) => c.name),
			["fanout-guard"],
		);
		assert.strictEqual(step3Branch(rollup), "settle-poll");
	});

	it("the branch mirror is not vacuous: a gating red heals, an all-green head proceeds", () => {
		const gatingRed = rollupChecks({
			checkRuns: [run({name: "ci-required", conclusion: "failure"})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(step3Branch(gatingRed), "heal-ci");

		const informationalRedOnly = rollupChecks({
			checkRuns: [run({name: "deploy (web)", conclusion: "failure"}), run({name: "lint"})],
			combinedStatus: noStatuses,
		});
		assert.strictEqual(informationalRedOnly.conclusion, "red");
		assert.strictEqual(step3Branch(informationalRedOnly), "proceed");
	});
});
