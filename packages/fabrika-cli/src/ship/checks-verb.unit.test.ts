import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {rollupFor, runChecks} from "./checks-verb.ts";
import {INCOMPLETE_SCAN, NO_GATE_COVERAGE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {checkRuns, ENV, HEAD, pull, runsTotal, workflows} from "./fixtures.test-support.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const COMMIT = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+$/;
const RUNS = /\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const WORKFLOWS = /\/repos\/o\/r\/actions\/workflows/;
const RUN_COUNT = /\/repos\/o\/r\/actions\/runs\?head_sha=/;

/**
 * A canned payload, served over HTTP rather than printed by a subprocess.
 *
 * The three CI reads moved to the fetch client; the payload shapes did not, so the fixtures stay
 * their one source and only the transport around them changes.
 */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

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
	shell: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runChecks({...options, ...overrides}),
			Layer.merge(fakeSeams([...shell, ...http]).layer, fakeFs({files}).layer),
		),
	);

/** The PR and the commit probe — a present PR at a commit the repository holds. */
const found: ReadonlyArray<Scripted> = [
	[PULL, served(pull())],
	[COMMIT, {status: 200, body: JSON.stringify({sha: HEAD})}],
];

const noRun = (name: string, status: string, conclusion: string | null = null) => ({
	name,
	status,
	conclusion,
});

const empty = {runs: [], ranAtHead: [], superseded: new Set<number>()};

/** An inventory of N workflows, path-addressed the way the platform answers. */
const inventory = (count: number): ReadonlyArray<string> =>
	Array.from({length: count}, (_, index) => `.github/w${index}.yml`);

/**
 * One sample's check rows, with the suites a newer run replaced.
 *
 * A row's `checkSuiteId` is the join `supersededSuites` computes over, so a test states the two
 * halves — the row's suite and the superseded set — rather than a "this is superseded" flag the
 * verb has no way to receive.
 */
const sampleOf = (
	rows: ReadonlyArray<{name: string; conclusion: string; suite?: number}>,
	superseded: ReadonlyArray<number> = [],
) => ({
	runs: rows.map((row, index) => ({
		name: row.name,
		status: "completed",
		conclusion: row.conclusion,
		startedAt: "2026-08-08T00:00:00Z",
		id: index + 1,
		checkSuiteId: row.suite ?? 1,
	})),
	workflows: inventory(1),
	runCount: 2,
	ranAtHead: [],
	superseded: new Set(superseded),
});

describe("rollupFor", () => {
	it("names any wedged check as the whole answer", () => {
		expect(rollupFor({...empty, workflows: inventory(3), runCount: 0}, ["ci-required"])).toBe(
			"wedged",
		);
	});

	it("is no-runs only with positive evidence: workflows exist and none fired at this head", () => {
		expect(rollupFor({...empty, workflows: inventory(12), runCount: 0}, [])).toBe("no-runs");
	});

	it("is no-producer on zero workflows, never collapsed into pending (#6298)", () => {
		expect(rollupFor({...empty, workflows: [], runCount: 0}, [])).toBe("no-producer");
	});

	it("keeps no-producer apart from pending — the second waits on a run, the first never will", () => {
		expect(rollupFor({...empty, workflows: inventory(1), runCount: 3}, [])).toBe("pending");
	});
});

// #6834: the repo cancels its own runs at an unmoved head, so `cancelled` there means "replaced",
// not "failed" — and the dependent aggregator is the row that lands in it.
describe("rollupFor over a concurrency-cancelled run", () => {
	it("pends a superseded cancelled aggregator rather than reding it", () => {
		expect(
			rollupFor(sampleOf([{name: "ci-required", conclusion: "cancelled", suite: 91}], [91]), []),
		).toBe("pending");
	});

	it("reds a cancelled run no newer run of its workflow replaced", () => {
		expect(
			rollupFor(sampleOf([{name: "ci-required", conclusion: "cancelled", suite: 91}]), []),
		).toBe("red");
	});

	it("reds when the newer run has already concluded failure at the same head", () => {
		const sample = sampleOf(
			[
				{name: "ci-required", conclusion: "cancelled", suite: 91},
				{name: "unit tests", conclusion: "failure", suite: 92},
			],
			[91],
		);
		expect(rollupFor(sample, [])).toBe("red");
	});

	it("never reclassifies a conclusion other than cancelled, however superseded its suite", () => {
		for (const conclusion of [
			"failure",
			"timed_out",
			"action_required",
			"startup_failure",
			"stale",
		]) {
			expect(rollupFor(sampleOf([{name: "ci-required", conclusion, suite: 91}], [91]), [])).toBe(
				"red",
			);
		}
	});

	it("leaves an informational run carved out on both sides of the rule (ADR 0061)", () => {
		const sample = sampleOf(
			[
				{name: "deploy (web)", conclusion: "cancelled", suite: 91},
				{name: "ci-required", conclusion: "success", suite: 92},
			],
			[91],
		);
		expect(rollupFor(sample, [])).toBe("green");
	});
});

describe("runChecks", () => {
	it("prints the rollup, the run count, the collapsed check tally, and the facts", async () => {
		const out = await run(found, [
			[
				RUNS,
				served(
					checkRuns(3, [
						noRun("ci-required", "completed", "success"),
						noRun("unit tests", "completed", "success"),
						noRun("deploy (web)", "completed", "failure"),
					]),
				),
			],
			[WORKFLOWS, served(workflows("active", "active"))],
			[RUN_COUNT, served(runsTotal(14))],
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
		const out = await run(found, [
			[
				RUNS,
				served(
					checkRuns(3, [
						noRun("unit tests", "completed", "failure"),
						noRun("deploy (web)", "completed", "failure"),
						noRun("ci-required", "completed", "success"),
					]),
				),
			],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, served(runsTotal(3))],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
		expect(out.stdout).toContain("check\tfailure/gating\t1");
		expect(out.stdout).toContain("check\tfailure/informational\t1");
		expect(out.stdout).toContain("check\tsuccess/gating\t1");
		expect(out.stdout).not.toContain("unit tests");
	});

	// The collapse costs the rows, never the route: `red` still has to hand `heal-ci` a name.
	it("names the failing gating runs on the notes channel, sorted, informational excluded", async () => {
		const out = await run(found, [
			[
				RUNS,
				served(
					checkRuns(3, [
						noRun("unit tests", "completed", "failure"),
						noRun("ci-required", "completed", "cancelled"),
						noRun("deploy (web)", "completed", "failure"),
					]),
				),
			],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, served(runsTotal(3))],
		]);
		expect(out.stderr).toContain(
			"ship checks: failing gating checks: ci-required, unit tests — route these to heal-ci.",
		);
	});

	it("names no failing check when the only failure is informational", async () => {
		const out = await run(found, [
			[
				RUNS,
				served(
					checkRuns(2, [
						noRun("deploy (web)", "completed", "failure"),
						noRun("unit tests", "completed", "success"),
					]),
				),
			],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, served(runsTotal(2))],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
		expect(out.stderr.join("\n")).not.toContain("failing gating checks");
	});

	it("mirrors the same collapsed tally into the --json payload", async () => {
		const out = await run(
			found,
			[
				[
					RUNS,
					served(
						checkRuns(3, [
							noRun("ci-required", "completed", "success"),
							noRun("unit tests", "completed", "success"),
							noRun("deploy (web)", "completed", "failure"),
						]),
					),
				],
				[WORKFLOWS, served(workflows("active", "active"))],
				[RUN_COUNT, served(runsTotal(14))],
			],
			{json: true},
		);
		expect(JSON.parse(out.stdout).checks).toEqual({
			"success/gating": 2,
			"failure/informational": 1,
		});
	});

	it("reds on a gating failure — the carve-out never covers a real check", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(1, [noRun("unit tests", "completed", "failure")]))],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, served(runsTotal(2))],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
	});

	it("dedupes to latest-per-context after the pages are joined", async () => {
		const out = await run(found, [
			[
				RUNS,
				served(
					checkRuns(2, [
						{...noRun("ci-required", "completed", "failure"), id: 1},
						{...noRun("ci-required", "completed", "success"), id: 2},
					]),
				),
			],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, served(runsTotal(2))],
		]);
		expect(out.stdout).toContain("run\t1");
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
	});

	it("reports no-runs with its two discriminators rather than an empty answer", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(0, []))],
			[WORKFLOWS, served(workflows("active", "active"))],
			[RUN_COUNT, served(runsTotal(0))],
		]);
		expect(out.stdout).toBe(
			[`checks\t${HEAD}\tno-runs`, "run\t0", "facts\tworkflows:2\truns:0", ""].join("\n"),
		);
	});

	it("refuses an unreadable enumeration on 11 — CI state is UNKNOWN, never green", async () => {
		const out = await run(found, [[RUNS, {status: 502, body: '{"message":"Bad gateway"}'}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("CI state is UNKNOWN, never green");
	});

	it("refuses a short enumeration on 13 — never read as `no red checks`", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(9, [noRun("unit tests", "completed", "success")]))],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[COMMIT, {status: 404, body: '{"message":"Not Found"}'}],
			],
			[],
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(`ship checks: no commit ${HEAD} on PR #4321.`);
	});
});

/**
 * #6915: the merge-authority twin of the review-side fail-open (#6522). Every check at the head
 * passed, and the workflows that produced them were the platform's own — so the word this group
 * merges on would have been printed over bytes no gate of the repo inspected.
 */
describe("the gate-coverage floor under a green head", () => {
	const CI = ".github/workflows/ci.yml";
	const CODEQL = "dynamic/github-code-scanning/codeql";

	/** A passing head whose only check runs came from platform-provided and informational suites. */
	const passingChecks = served(
		checkRuns(2, [
			noRun("CodeQL", "completed", "success"),
			noRun("deploy (web)", "completed", "success"),
		]),
	);

	it("refuses on 20 when the repo declares a gate and none of them ran at this head", async () => {
		const out = await run(found, [
			[RUNS, passingChecks],
			[WORKFLOWS, served(workflows({path: CI}, {path: CODEQL}))],
			[RUN_COUNT, served(runsTotal(1, [{id: 11, path: CODEQL}]))],
		]);
		expect(out.code).toBe(NO_GATE_COVERAGE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`ship checks: none of the 1 workflow(s) o/r authors produced a run at ${HEAD} — the 2 check run(s) here came from elsewhere, so no gate inspected the bytes this merge would land: green is UNKNOWN, never merged (#6915).`,
		);
	});

	it("answers green when the declared gate workflow produced a run at this head", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(1, [noRun("ci-required", "completed", "success")]))],
			[WORKFLOWS, served(workflows({path: CI}, {path: CODEQL}))],
			[
				RUN_COUNT,
				served(
					runsTotal(2, [
						{id: 11, path: CI},
						{id: 12, path: CODEQL, workflowId: 2},
					]),
				),
			],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
		expect(out.stderr).toContain(
			`ship checks: 1 of 1 workflow(s) o/r authors produced a run at ${HEAD}.`,
		);
	});

	it("judges no coverage on a repo that authors no workflow of its own", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(1, [noRun("CodeQL", "completed", "success")]))],
			[WORKFLOWS, served(workflows({path: CODEQL}))],
			[RUN_COUNT, served(runsTotal(1, [{id: 11, path: CODEQL}]))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tgreen`);
		expect(out.stderr).toContain(
			`ship checks: o/r authors no workflow of its own — every run at ${HEAD} is platform-provided, so there is no gate coverage to judge.`,
		);
	});

	// The floor sits on `green` alone: a `red` head already routes to `heal-ci` by name, and swapping
	// that route for a coverage refusal would lose the names the route is made of.
	it("leaves a red ungated head red rather than refusing it", async () => {
		const out = await run(found, [
			[RUNS, served(checkRuns(1, [noRun("unit tests", "completed", "failure")]))],
			[WORKFLOWS, served(workflows({path: CI}))],
			[RUN_COUNT, served(runsTotal(1, [{id: 11, path: CODEQL}]))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
	});
});

/**
 * The incident head of #6834, end to end: a close/reopen re-fired the suite without moving the head,
 * so the older run was concurrency-cancelled and the newer run had not published its own
 * `ci-required` yet. The verb read the cancelled aggregator and settled red on the first sample.
 */
describe("the concurrency-cancelled head", () => {
	const cancelledAggregator = served(
		checkRuns(1, [{...noRun("ci-required", "completed", "cancelled"), check_suite_id: 91}]),
	);

	/** The older run cancelled, the newer run of the same workflow still going, at one head. */
	const supersededRuns = served(
		runsTotal(2, [
			{id: 11, workflowId: 7, checkSuiteId: 91, conclusion: "cancelled"},
			{id: 12, workflowId: 7, checkSuiteId: 92, status: "in_progress", conclusion: null},
		]),
	);

	it("reads pending, names the replaced context, and routes nothing to heal-ci", async () => {
		const out = await run(found, [
			[RUNS, cancelledAggregator],
			[WORKFLOWS, served(workflows("active"))],
			[RUN_COUNT, supersededRuns],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tpending`);
		expect(out.stdout).toContain("check\tcancelled-superseded/gating\t1");
		expect(out.stderr).toContain(
			"ship checks: cancelled by a newer run of the same workflow at this head: ci-required — waiting on that run, not routing.",
		);
		expect(out.stderr.join("\n")).not.toContain("failing gating checks");
	});

	it("reds the same head when no newer run of that workflow exists", async () => {
		const out = await run(found, [
			[RUNS, cancelledAggregator],
			[WORKFLOWS, served(workflows("active"))],
			[
				RUN_COUNT,
				served(runsTotal(1, [{id: 11, workflowId: 7, checkSuiteId: 91, conclusion: "cancelled"}])),
			],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`checks\t${HEAD}\tred`);
		expect(out.stderr).toContain(
			"ship checks: failing gating checks: ci-required — route these to heal-ci.",
		);
	});

	it("--wait stays in the loop and settles on the newer run's verdict, not the cancel", async () => {
		const out = await run(
			found,
			[
				[once(RUNS), cancelledAggregator],
				[
					RUNS,
					served(
						checkRuns(1, [
							{...noRun("ci-required", "completed", "success"), id: 5, check_suite_id: 92},
						]),
					),
				],
				[WORKFLOWS, served(workflows("active"))],
				[once(RUN_COUNT), supersededRuns],
				[
					RUN_COUNT,
					served(
						runsTotal(2, [
							{id: 11, workflowId: 7, checkSuiteId: 91, conclusion: "cancelled"},
							{id: 12, workflowId: 7, checkSuiteId: 92, conclusion: "success"},
						]),
					),
				],
			],
			{wait: true, cadenceSeconds: 0},
		);
		expect(out.stdout.split("\n").slice(0, 2)).toEqual([
			"settle\tsettled",
			`checks\t${HEAD}\tgreen`,
		]);
	});
});

describe("the no-producer split", () => {
	const noWorkflows: ReadonlyArray<Scripted> = [
		[RUNS, served(checkRuns(0, []))],
		[WORKFLOWS, served(workflows())],
		[RUN_COUNT, served(runsTotal(0))],
	];

	it("refuses zero workflows on 7 by default", async () => {
		const out = await run(found, noWorkflows);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("zero workflows — no CI producer");
	});

	it("prints no-producer, never pending and never green, when the repo declares degrade", async () => {
		const out = await run(found, noWorkflows, {}, {[CONFIG]: '{"ci": {"noProducer": "degrade"}}'});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[`checks\t${HEAD}\tno-producer`, "run\t0", "facts\tworkflows:0\truns:0", ""].join("\n"),
		);
		expect(out.stderr.at(-1)).toContain("no producer, so there is nothing to roll up");
	});

	it("refuses an off-vocabulary noProducer on 11 — never the shipped default", async () => {
		const out = await run(found, noWorkflows, {}, {[CONFIG]: '{"ci": {"noProducer": "ignore"}}'});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is not one of refuse, degrade");
	});
});
