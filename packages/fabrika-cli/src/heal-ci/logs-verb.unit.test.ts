import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runClassify} from "./classify-verb.ts";
import {INCOMPLETE_SCAN, LOGS_EXPIRED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	checkRuns,
	ENV,
	HEAD,
	httpError,
	JOB_LOG,
	JOBS,
	jobs,
	PROTECTION,
	planGated,
	protection,
	pull,
	RULES,
	rules,
	runsAtHead,
	UNDECLARED,
} from "./fixtures.test-support.ts";
import {runLogs, tailBytes} from "./logs-verb.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const CHECK_RUNS = /^GET .*\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const RUNS_AT_HEAD = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const options = {
	pr: 4321,
	sha: "",
	context: "",
	maxBytes: 65536,
	repo: null,
	json: false,
	env: ENV,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runLogs({...options, ...overrides}),
			fakeSeams([...script, ...UNDECLARED]).layer,
		),
	);

/** A served log body: the bytes GitHub's signed URL answers with, not JSON. */
const logText = (text: string): HttpReply => ({status: 200, body: text});

const failed = (name: string) => ({name, status: "completed", conclusion: "failure"});
const passed = (name: string) => ({name, status: "completed", conclusion: "success"});

describe("tailBytes", () => {
	it("keeps the LAST n bytes, because the failure is at the end", () => {
		expect(tailBytes("abcdef", 3)).toEqual({text: "def", bytes: 3, truncated: true});
	});

	it("declares nothing truncated when the whole log fits", () => {
		expect(tailBytes("abc", 10).truncated).toBe(false);
	});
});

describe("runLogs reads every failing gating context, not the first", () => {
	it("frames one block per failing context with its job, bytes and truncation", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[
				CHECK_RUNS,
				reply(checkRuns(3, [failed("unit tests"), failed("typecheck"), passed("lint")])),
			],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[
				JOBS,
				jobs(2, [
					{id: 441, name: "unit tests"},
					{id: 442, name: "typecheck"},
				]),
			],
			[JOB_LOG, logText("AssertionError: expected 3 to be 2")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t2\t${HEAD}`);
		expect(out.stdout).toContain("==== context unit tests job 441 bytes 34 truncated false ====");
		expect(out.stdout).toContain("==== context typecheck job 442 bytes 34 truncated false ====");
	});

	it("answers `logs 0` when nothing gating is failing — a proven answer, not a refusal", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [passed("ci-required")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(0, []))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`logs\t0\t${HEAD}\n`);
	});

	it("excludes an informational context before anything is fetched", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("deploy (web)")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(0, []))],
		]);
		expect(out.stdout).toBe(`logs\t0\t${HEAD}\n`);
	});

	// The required set is the blocking authority: a red the base branch does not require is a note,
	// so its log is never fetched and this lane never opens over it.
	it("fetches the required red's log and leaves the non-required red named on the notices", async () => {
		const out = await run([
			[RULES, rules("ci-required")],
			[PROTECTION, protection()],
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(2, [failed("ci-required"), failed("Analyze (python)")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "ci-required"}])],
			[JOB_LOG, logText("boom")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t1\t${HEAD}`);
		expect(out.stdout).toContain("==== context ci-required job 441");
		expect(out.stdout).not.toContain("Analyze (python)");
		expect(out.stderr.join("\n")).toContain(
			"failing outside the required set: Analyze (python) — reported, never blocking.",
		);
	});

	it("refuses on 11 when the required set cannot be read, naming that read as the cause", async () => {
		const out = await run([
			[RULES, httpError(403, "Resource not accessible by integration")],
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read main's required status checks");
	});

	it("reads the failing logs over a plan-gated base, naming the plan gate as the authority", async () => {
		const out = await run([
			[RULES, planGated],
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, logText("AssertionError")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t1\t${HEAD}`);
		expect(out.stderr.join("\n")).toContain(
			"main's plan offers no branch protection or rulesets — every non-informational check blocks",
		);
	});

	it("emits a context with no workflow job behind it rather than failing the whole read", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(2, [failed("external scan"), failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, logText("AssertionError")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t2\t${HEAD}`);
		expect(out.stdout).toContain("==== context external scan job - bytes 0 truncated false ====");
		expect(out.stderr.join("\n")).toContain("posted by an external check");
	});

	it("declares truncation rather than letting a bounded log read as complete", async () => {
		const out = await run(
			[
				[PULL, reply(pull())],
				[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
				[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
				[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
				[JOB_LOG, logText("0123456789")],
			],
			{maxBytes: 4},
		);
		expect(out.stdout).toContain("bytes 4 truncated true");
		expect(out.stderr.join("\n")).toContain("truncated to the last 4 bytes of 10");
	});
});

describe("runLogs refuses rather than answering `no failed steps`", () => {
	it("refuses expired logs on 15 — a fact about the run, not a failed read", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, httpError(410, "Gone")],
		]);
		expect(out.code).toBe(LOGS_EXPIRED);
		expect(out.stdout).toBe("");
	});

	it("refuses a purged log on 15 when the platform answers 404 rather than 410", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, httpError(404, "Not Found")],
		]);
		expect(out.code).toBe(LOGS_EXPIRED);
		expect(out.stdout).toBe("");
	});

	it("names GitHub's own message when the job-log read is refused on 11", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, httpError(500, "Server Error")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("GitHub answered HTTP 500: Server Error");
	});

	it("falls back to the bare status when the refused job-log body carries no message", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, {status: 500, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("GitHub answered HTTP 500");
		expect(out.stderr.at(-1)).not.toContain("HTTP 500:");
	});

	it("refuses an unreadable check-run read on 11", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, httpError(502, "Bad gateway")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "no failed steps"');
	});

	it("refuses a short job enumeration on 13", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(9, [{id: 441, name: "unit tests"}])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a --context naming no failing gating context on 7, listing the ones there are", async () => {
		const out = await run(
			[
				[PULL, reply(pull())],
				[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			],
			{context: "typecheck"},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("failing contexts are: unit tests");
	});
});

describe("runLogs follows a failing required roll-up to the jobs its FAIL lines name", () => {
	const ROLLUP = "all checks";
	const WORKFLOW = ".github/workflows/ci.yml";
	const CONTENTS = /^GET .*\/repos\/o\/r\/contents\/\.github\/workflows\/ci\.yml\?ref=/;
	const logOf = (job: number) => new RegExp(`/actions/jobs/${job}/logs$`);
	const workflowFile = (yaml: string): HttpReply => ({status: 200, body: yaml});

	const YAML = [
		"jobs:",
		"  unit:",
		"    name: unit + client tests",
		"  packages-tests:",
		"    name: packages unit tests",
		"  lint:",
		"    strategy:",
		"      matrix:",
		"        node: [22, 24]",
		"  all-checks:",
		`    name: ${ROLLUP}`,
	].join("\n");

	const rollupLog = (...lines: ReadonlyArray<string>) =>
		[
			"2026-10-04T00:54:02.31Z packages-tests: should_run=true result=success → required-pass",
			...lines,
			`2026-10-04T00:54:02.33Z ##[error]${ROLLUP} FAILED — see per-job verdicts above`,
		].join("\n");

	const script = (log: string): ReadonlyArray<Scripted> => [
		[RULES, rules(ROLLUP)],
		[PROTECTION, protection()],
		[PULL, reply(pull())],
		[
			CHECK_RUNS,
			reply(
				checkRuns(3, [
					{...failed(ROLLUP), id: 10, check_suite_id: 77},
					{...failed("unit + client tests"), id: 11, check_suite_id: 77},
					{...failed("Analyze (python)"), id: 12, check_suite_id: 99},
				]),
			),
		],
		[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77, path: WORKFLOW}]))],
		[
			JOBS,
			jobs(3, [
				{id: 441, name: ROLLUP},
				{id: 442, name: "unit + client tests"},
				{id: 443, name: "packages unit tests", conclusion: "success"},
			]),
		],
		[CONTENTS, workflowFile(YAML)],
		[logOf(441), logText(log)],
		[logOf(442), logText("AssertionError: expected [] to deeply equal [ '/tmp/x' ]")],
	];

	const UNIT_FAILED =
		"2026-10-04T00:54:02.32Z ##[error]unit: should_run=true result=failure → FAIL (a should-have-run gating job did not succeed — silent no-op)";

	it("emits the named job's frame right after the roll-up's, and classify classes both", async () => {
		const out = await run(script(rollupLog(UNIT_FAILED)));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t2\t${HEAD}`);
		const headers = out.stdout.split("\n").filter((line) => line.startsWith("==== context"));
		expect(headers.map((line) => line.split(" bytes ")[0])).toEqual([
			`==== context ${ROLLUP} job 441`,
			"==== context unit + client tests job 442",
		]);

		const classified = await Effect.runPromise(
			runClassify({json: false, stdin: Effect.succeed({_tag: "Text", text: out.stdout})}),
		);
		const classes = classified.stdout.split("\n").filter((line) => line.startsWith("class\t"));
		expect(classes.map((line) => line.split("\t").slice(1, 3))).toEqual([
			[ROLLUP, "derived"],
			["unit + client tests", "logic"],
		]);
	});

	it("says the named job blocks through the roll-up, and keeps an unnamed red reported and unfetched", async () => {
		const out = await run(script(rollupLog(UNIT_FAILED)));
		const stderr = out.stderr.join("\n");
		expect(stderr).toContain(
			`failing outside the required set: unit + client tests — blocks through the failing required context ${ROLLUP}.`,
		);
		expect(stderr).toContain(
			"failing outside the required set: Analyze (python) — reported, never blocking.",
		);
		expect(stderr).not.toContain("unit + client tests — reported, never blocking");
		expect(out.stdout).not.toContain("Analyze (python)");
	});

	it("reports a named key it cannot tie on stderr, by its key, and reads no other job's log", async () => {
		const out = await run(
			script(
				rollupLog(
					"2026-10-04T00:54:02.32Z ##[error]lint: should_run=true result=failure → FAIL (…)",
					"2026-10-04T00:54:02.32Z ##[error]ghost: should_run=true result=cancelled → FAIL (…)",
				),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t1\t${HEAD}`);
		expect(out.stdout).not.toContain("==== context unit + client tests");
		const stderr = out.stderr.join("\n");
		expect(stderr).toContain(
			`${ROLLUP} names job lint, which cannot be tied to a check run: it is a matrix job, whose check runs carry a composed name — no log is read in its place.`,
		);
		expect(stderr).toContain(
			`${ROLLUP} names job ghost, which cannot be tied to a check run: the workflow file declares no job by that key — no log is read in its place.`,
		);
		// Nothing tied to it, so the job that did fail stays a reported red.
		expect(stderr).toContain(
			"failing outside the required set: Analyze (python), unit + client tests — reported, never blocking.",
		);
	});

	it("refuses on 11 when the roll-up's workflow file cannot be read", async () => {
		const out = await run([
			[CONTENTS, httpError(500, "Server Error")],
			...script(rollupLog(UNIT_FAILED)),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(`cannot read ${WORKFLOW} at`);
	});
});
