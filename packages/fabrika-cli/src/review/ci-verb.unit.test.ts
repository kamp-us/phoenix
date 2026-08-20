import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {workflows} from "../ship/fixtures.test-support.ts";
import {runCi} from "./ci-verb.ts";
import {INCOMPLETE_SCAN, NO_GATE_COVERAGE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {checkRuns, HEAD, inventory, OLD_HEAD, pull, runsAtHead} from "./fixtures.test-support.ts";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321$/;
const COMMIT = (sha: string) => new RegExp(`GET .*/repos/o/r/commits/${sha}$`);
const RUNS = /GET .*\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const WORKFLOWS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/workflows\?/;
const AT_HEAD = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\?head_sha=/;
const CONFIG = "/repo/.fabrika.jsonc";

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const BAD_GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};
const NOT_FOUND = '{"message":"Not Found"}';

/** The check-run envelope at a commit, as the platform serves it. */
const runs = (
	declared: number,
	list: ReadonlyArray<{name: string; status: string; conclusion: string | null}>,
): HttpReply => served(checkRuns(declared, list));

const GREEN = runs(3, [
	{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
	{name: "unit tests", status: "completed", conclusion: "success"},
	{name: "leak-guard", status: "completed", conclusion: "success"},
]);

const CI_YML = ".github/workflows/ci.yml";
const GUARD_YML = ".github/workflows/leak-guard.yml";
const CODEQL = "dynamic/github-code-scanning/codeql";

/** The repo's own gates ran here — the coverage reads every non-red rollup now owes. */
const GATED: ReadonlyArray<Scripted> = [
	[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
	[AT_HEAD, served(runsAtHead(CI_YML, GUARD_YML))],
];

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: "/repo",
};

const run = (
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted> = [],
	overrides: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runCi({...options, ...overrides}),
			Layer.merge(fakeSeams([...script, ...http]).layer, fakeFs({files}).layer),
		),
	);

describe("runCi", () => {
	it("prints the rollup, the count of lines that follow, and one line per run", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`ci\t${HEAD}\tgreen`,
				"check\t3",
				"lint / format / typecheck\tsuccess",
				"unit tests\tsuccess",
				"leak-guard\tsuccess",
				"",
			].join("\n"),
		);
	});

	it("names a red check by name, not as a rollup boolean", async () => {
		const out = await run([
			[PULL, served(pull())],
			[
				RUNS,
				runs(2, [
					{name: "unit tests", status: "completed", conclusion: "failure"},
					{name: "leak-guard", status: "completed", conclusion: "success"},
				]),
			],
		]);
		expect(out.stdout).toContain("\tred\n");
		expect(out.stdout).toContain("unit tests\tfailure");
	});

	it("enumerates at --sha and notices when the live head has moved past it", async () => {
		const out = await run(
			[
				[PULL, served(pull({head: HEAD}))],
				[COMMIT(OLD_HEAD), {status: 200, body: JSON.stringify({sha: OLD_HEAD})}],
				[RUNS, GREEN],
			],
			GATED,
			{sha: OLD_HEAD},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${OLD_HEAD}\tgreen`);
		expect(out.stderr[0]).toContain("the head moved");
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[COMMIT(OLD_HEAD), {status: 404, body: NOT_FOUND}],
			],
			[],
			{sha: OLD_HEAD},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(`review ci: no commit ${OLD_HEAD} on PR #4321 in o/r.`);
	});

	it("refuses zero declared check runs on 7 — a vacuous green is the ADR 0092 fail-open", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, runs(0, [])],
			],
			[[WORKFLOWS, served(workflows("active", "active"))]],
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing to report green over an empty enumeration");
	});

	it("refuses a short enumeration on 13 — never read as `no red checks`", async () => {
		const out = await run([
			[PULL, served(pull())],
			[RUNS, runs(9, [{name: "unit tests", status: "completed", conclusion: "success"}])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review ci: received 1 of 9 declared check runs at ${HEAD} — refusing the partial enumeration (#3999).`,
		);
	});

	it("refuses an unreadable enumeration on 11 — CI state is UNKNOWN, never green", async () => {
		const out = await run([
			[PULL, served(pull())],
			[RUNS, BAD_GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("CI state is UNKNOWN, never green");
	});

	it("reports what it scanned against what was declared", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
		);
		expect(out.stderr).toContain("review ci: scanned 3 check runs; 3 declared.");
	});
});

describe("the gate-coverage read", () => {
	/** The live incident: a conflicted head where only CodeQL's default setup reported (#6522). */
	const CODEQL_ONLY = runs(4, [
		{name: "CodeQL", status: "completed", conclusion: "success"},
		{name: "Analyze (actions)", status: "completed", conclusion: "success"},
		{name: "Analyze (javascript-typescript)", status: "completed", conclusion: "success"},
		{name: "Analyze (javascript-typescript)", status: "completed", conclusion: "success"},
	]);

	it("refuses an all-passed CodeQL-only head on 16 — never green over ungated bytes", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, CODEQL_ONLY],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
				[AT_HEAD, served(runsAtHead(CODEQL))],
			],
		);
		expect(out.code).toBe(NO_GATE_COVERAGE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review ci: none of the 2 workflow(s) o/r authors produced a run at ${HEAD} — the 4 check run(s) here came from elsewhere, so no gate inspected these bytes (#6522).`,
		);
	});

	it("refuses a pending rollup with no gate coverage too — the reviewer would wait forever", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, runs(1, [{name: "CodeQL", status: "in_progress", conclusion: null}])],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, CODEQL))],
				[AT_HEAD, served(runsAtHead(CODEQL))],
			],
		);
		expect(out.code).toBe(NO_GATE_COVERAGE);
	});

	it("names the coverage it judged when the repo's own gates did run", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
		);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain(
			`review ci: 2 of 2 workflow(s) o/r authors produced a run at ${HEAD}.`,
		);
	});

	it("carries the coverage on the --json object", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
			{json: true},
		);
		expect(JSON.parse(out.stdout).gates).toEqual({declared: 2, covered: 2});
	});

	it("never asks the coverage question over a red rollup — red is already the answer", async () => {
		// No WORKFLOWS or AT_HEAD entry in the script: a call would fail the fake, which is the
		// assertion. A red check names itself; refusing it as ungated would bury that.
		const out = await run([
			[PULL, served(pull())],
			[RUNS, runs(1, [{name: "unit tests", status: "completed", conclusion: "failure"}])],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tred\n");
	});

	it("judges no coverage when the repo authors no workflow of its own", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CODEQL))],
				[AT_HEAD, served(runsAtHead(CODEQL))],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`ci\t${HEAD}\tgreen`);
		expect(out.stderr).toContain(
			"review ci: o/r authors no workflow of its own — every run at " +
				`${HEAD} is platform-provided, so there is no gate coverage to judge.`,
		);
	});

	it("refuses an unreadable inventory on 11 — which gates exist is UNKNOWN, never green", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			[[WORKFLOWS, BAD_GATEWAY]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("which gates exist is UNKNOWN, never green");
	});

	it("refuses an unreadable run list on 11 — which gates ran is UNKNOWN, never green", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML))],
				[AT_HEAD, BAD_GATEWAY],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("which gates ran is UNKNOWN, never green");
	});
});

describe("the no-producer split", () => {
	const empty: ReadonlyArray<Scripted> = [
		[PULL, served(pull())],
		[RUNS, runs(0, [])],
	];

	it("never asks the producer question while checks are reporting", async () => {
		// The inventory is read on both paths now — the gate-coverage read needs it — so the
		// assertion moves to the config, which only the producer question consults: a `ci` key this
		// malformed refuses on 11 the moment anything asks it, and nothing here does.
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
			{},
			{[CONFIG]: '{"ci": {"noProducer": "ignore"}}'},
		);
		expect(out.code).toBe(0);
	});

	it("refuses zero workflows on 7 by default — no producer, so no head can be evidenced", async () => {
		const out = await run(empty, [[WORKFLOWS, served(workflows())]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("zero workflows — no CI producer");
	});

	it("rolls up no-producer, never green, when the repo declares degrade", async () => {
		const out = await run(
			empty,
			[[WORKFLOWS, served(workflows())]],
			{},
			{
				[CONFIG]: '{"ci": {"noProducer": "degrade"}}',
			},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe([`ci\t${HEAD}\tno-producer`, "check\t0", ""].join("\n"));
		expect(out.stdout).not.toContain("green");
	});

	it("refuses an off-vocabulary noProducer on 11 — never the shipped default", async () => {
		const out = await run(
			empty,
			[[WORKFLOWS, served(workflows())]],
			{},
			{
				[CONFIG]: '{"ci": {"noProducer": "ignore"}}',
			},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is not one of refuse, degrade");
	});

	it("refuses an unreadable workflow inventory on 11 — never `no producer`", async () => {
		const out = await run(empty, [[WORKFLOWS, BAD_GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("whether a producer exists is UNKNOWN, never green");
	});
});
