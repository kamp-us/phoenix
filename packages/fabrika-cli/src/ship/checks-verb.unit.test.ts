import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {rollupFor, runChecks} from "./checks-verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {checkRuns, ENV, HEAD, pull, runsTotal, workflows} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const COMMIT = /^gh api repos\/o\/r\/commits\/[0-9a-f]+ --jq \.sha$/;
const RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const WORKFLOWS = /^gh api --paginate repos\/o\/r\/actions\/workflows/;
const RUN_COUNT = /^gh api repos\/o\/r\/actions\/runs\?head_sha=/;

const options = {
	pr: 4321,
	sha: HEAD,
	wait: false,
	budgetSeconds: 600,
	cadenceSeconds: 30,
	wedgeDwellSeconds: 120,
	repo: null,
	json: false,
	env: ENV,
	cwd: "/repo",
};

const CONFIG = "/repo/.fabrika.jsonc";

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runChecks({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeFs({files}).layer),
		),
	);

const noRun = (name: string, status: string, conclusion: string | null = null) => ({
	name,
	status,
	conclusion,
});

describe("rollupFor", () => {
	it("names any wedged check as the whole answer", () => {
		expect(rollupFor({runs: [], workflows: 3, runCount: 0}, ["ci-required"])).toBe("wedged");
	});

	it("is no-runs only with positive evidence: workflows exist and none fired at this head", () => {
		expect(rollupFor({runs: [], workflows: 12, runCount: 0}, [])).toBe("no-runs");
	});

	it("is no-producer on zero workflows, never collapsed into pending (#6298)", () => {
		expect(rollupFor({runs: [], workflows: 0, runCount: 0}, [])).toBe("no-producer");
	});

	it("keeps no-producer apart from pending — the second waits on a run, the first never will", () => {
		expect(rollupFor({runs: [], workflows: 1, runCount: 3}, [])).toBe("pending");
	});
});

describe("runChecks", () => {
	it("prints the rollup, the run count, the collapsed check tally, and the facts", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[
				RUNS,
				checkRuns(3, [
					noRun("ci-required", "completed", "success"),
					noRun("unit tests", "completed", "success"),
					noRun("deploy (web)", "completed", "failure"),
				]),
			],
			[WORKFLOWS, workflows("active", "active")],
			[RUN_COUNT, runsTotal(14)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`checks\t${HEAD}\tgreen`,
				"run\t3",
				"check\tsuccess/gating\t2",
				"check\tfailure/informational\t1",
				"facts\tworkflows:2\truns:14",
				"",
			].join("\n"),
		);
	});

	// ADR 0308: `checks` is an evidence-array, so it collapses to counts — but the gating axis stays
	// in the key, or a `red` head and this one (a failing *informational* run) would tally the same.
	it("tallies the collapsed checks by status AND gating, count-descending", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[
				RUNS,
				checkRuns(3, [
					noRun("unit tests", "completed", "failure"),
					noRun("deploy (web)", "completed", "failure"),
					noRun("ci-required", "completed", "success"),
				]),
			],
			[WORKFLOWS, workflows("active")],
			[RUN_COUNT, runsTotal(3)],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
		expect(out.stdout).toContain("check\tfailure/gating\t1");
		expect(out.stdout).toContain("check\tfailure/informational\t1");
		expect(out.stdout).toContain("check\tsuccess/gating\t1");
		expect(out.stdout).not.toContain("unit tests");
	});

	// The collapse costs the rows, never the route: `red` still has to hand `heal-ci` a name.
	it("names the failing gating runs on the notes channel, sorted, informational excluded", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[
				RUNS,
				checkRuns(3, [
					noRun("unit tests", "completed", "failure"),
					noRun("ci-required", "completed", "cancelled"),
					noRun("deploy (web)", "completed", "failure"),
				]),
			],
			[WORKFLOWS, workflows("active")],
			[RUN_COUNT, runsTotal(3)],
		]);
		expect(out.stderr).toContain(
			"ship checks: failing gating checks: ci-required, unit tests — route these to heal-ci.",
		);
	});

	it("names no failing check when the only failure is informational", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[
				RUNS,
				checkRuns(2, [
					noRun("deploy (web)", "completed", "failure"),
					noRun("unit tests", "completed", "success"),
				]),
			],
			[WORKFLOWS, workflows("active")],
			[RUN_COUNT, runsTotal(2)],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
		expect(out.stderr.join("\n")).not.toContain("failing gating checks");
	});

	it("mirrors the same collapsed tally into the --json payload", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMIT, okOut(HEAD)],
				[
					RUNS,
					checkRuns(3, [
						noRun("ci-required", "completed", "success"),
						noRun("unit tests", "completed", "success"),
						noRun("deploy (web)", "completed", "failure"),
					]),
				],
				[WORKFLOWS, workflows("active", "active")],
				[RUN_COUNT, runsTotal(14)],
			],
			{json: true},
		);
		expect(JSON.parse(out.stdout).checks).toEqual({
			"success/gating": 2,
			"failure/informational": 1,
		});
	});

	it("reds on a gating failure — the carve-out never covers a real check", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[RUNS, checkRuns(1, [noRun("unit tests", "completed", "failure")])],
			[WORKFLOWS, workflows("active")],
			[RUN_COUNT, runsTotal(2)],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
	});

	it("dedupes to latest-per-context after the pages are joined", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[
				RUNS,
				checkRuns(2, [
					{...noRun("ci-required", "completed", "failure"), id: 1},
					{...noRun("ci-required", "completed", "success"), id: 2},
				]),
			],
			[WORKFLOWS, workflows("active")],
			[RUN_COUNT, runsTotal(2)],
		]);
		expect(out.stdout).toContain("run\t1");
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
	});

	it("reports no-runs with its two discriminators rather than an empty answer", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[RUNS, checkRuns(0, [])],
			[WORKFLOWS, workflows("active", "active")],
			[RUN_COUNT, runsTotal(0)],
		]);
		expect(out.stdout).toBe(
			[`checks\t${HEAD}\tno-runs`, "run\t0", "facts\tworkflows:2\truns:0", ""].join("\n"),
		);
	});

	it("refuses an unreadable enumeration on 11 — CI state is UNKNOWN, never green", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[RUNS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("CI state is UNKNOWN, never green");
	});

	it("refuses a short enumeration on 13 — never read as `no red checks`", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[RUNS, checkRuns(9, [noRun("unit tests", "completed", "success")])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(`ship checks: no commit ${HEAD} on PR #4321.`);
	});
});

describe("the no-producer split", () => {
	const noWorkflows: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		[COMMIT, okOut(HEAD)],
		[RUNS, checkRuns(0, [])],
		[WORKFLOWS, workflows()],
		[RUN_COUNT, runsTotal(0)],
	];

	it("refuses zero workflows on 7 by default", async () => {
		const out = await run(noWorkflows);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("zero workflows — no CI producer");
	});

	it("prints no-producer, never pending and never green, when the repo declares degrade", async () => {
		const out = await run(noWorkflows, {}, {[CONFIG]: '{"ci": {"noProducer": "degrade"}}'});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[`checks\t${HEAD}\tno-producer`, "run\t0", "facts\tworkflows:0\truns:0", ""].join("\n"),
		);
		expect(out.stderr.at(-1)).toContain("no producer, so there is nothing to roll up");
	});

	it("refuses an off-vocabulary noProducer on 11 — never the shipped default", async () => {
		const out = await run(noWorkflows, {}, {[CONFIG]: '{"ci": {"noProducer": "ignore"}}'});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is not one of refuse, degrade");
	});
});
