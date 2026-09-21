import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	httpError,
	PROTECTION,
	protection,
	RULES,
	rules,
	UNDECLARED,
	workflows,
} from "../ship/fixtures.test-support.ts";
import {CHECK_RUN_NAME, planFor} from "../ship/floor-check.ts";
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
	list: ReadonlyArray<{name: string; status: string; conclusion: string | null; title?: string}>,
): HttpReply => served(checkRuns(declared, list));

const GREEN = runs(3, [
	{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
	{name: "unit tests", status: "completed", conclusion: "success"},
	{name: "leak-guard", status: "completed", conclusion: "success"},
]);

const CI_YML = ".github/workflows/ci.yml";
const GUARD_YML = ".github/workflows/leak-guard.yml";
/** Checked into the repo and fired on `pull_request_target` — repo-authored, base-context. */
const CLEANUP_YML = ".github/workflows/pr-cleanup.yml";
const CODEQL = "dynamic/github-code-scanning/codeql";

/** The repo's own gates ran here — the coverage reads every non-red rollup now owes. */
const GATED: ReadonlyArray<Scripted> = [
	[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
	[AT_HEAD, served(runsAtHead(CI_YML, GUARD_YML))],
];

const options = {
	pr: 4321,
	sha: null as string | null,
	wait: false,
	budgetSeconds: 600,
	cadenceSeconds: 30,
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
			Layer.merge(fakeSeams([...script, ...http, ...UNDECLARED]).layer, fakeFs({files}).layer),
		),
	);

/**
 * This verb used to roll up every run at the head with no blocking dimension at all, so any red
 * anywhere made it call the head red. The base branch's declared required set is the authority now.
 */
describe("runCi under the base branch's required set", () => {
	const REQUIRES: ReadonlyArray<Scripted> = [
		[RULES, rules("unit tests")],
		[PROTECTION, protection()],
	];

	it("is green over a red no declared context names, and names it on the notes", async () => {
		const out = await run(
			[
				...REQUIRES,
				[PULL, served(pull())],
				[
					RUNS,
					runs(2, [
						{name: "unit tests", status: "completed", conclusion: "success"},
						{name: "Analyze (python)", status: "completed", conclusion: "failure"},
					]),
				],
			],
			GATED,
		);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tgreen`);
		expect(out.stderr.join("\n")).toContain(
			"failing outside the required set: Analyze (python) — reported, never blocking.",
		);
	});

	// The tally is the whole enumeration's, unchanged: the rollup narrowed, the evidence did not.
	it("still tallies the non-required run it did not roll up", async () => {
		const out = await run(
			[
				...REQUIRES,
				[PULL, served(pull())],
				[
					RUNS,
					runs(2, [
						{name: "unit tests", status: "completed", conclusion: "success"},
						{name: "Analyze (python)", status: "completed", conclusion: "failure"},
					]),
				],
			],
			GATED,
		);
		expect(out.stdout).toContain("check\tfailure\t1");
		expect(out.stdout).toContain("run\t2");
	});

	it("is red when the failing context is one the base branch declares required", async () => {
		const out = await run([
			...REQUIRES,
			[PULL, served(pull())],
			[
				RUNS,
				runs(2, [
					{name: "unit tests", status: "completed", conclusion: "failure"},
					{name: "Analyze (python)", status: "completed", conclusion: "success"},
				]),
			],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tred`);
		expect(out.stderr.join("\n")).toContain("review ci: failing at this head: unit tests.");
	});

	// A non-required run still in flight is not something this head is waiting on.
	it("does not pend on a still-running check outside the required set", async () => {
		const out = await run(
			[
				...REQUIRES,
				[PULL, served(pull())],
				[
					RUNS,
					runs(2, [
						{name: "unit tests", status: "completed", conclusion: "success"},
						{name: "Analyze (python)", status: "in_progress", conclusion: null},
					]),
				],
			],
			GATED,
		);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tgreen`);
	});

	it("refuses on 11 when the required set cannot be read, never a colour over it", async () => {
		const out = await run([
			[RULES, httpError(403, "Resource not accessible by integration")],
			[PULL, served(pull())],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read main's required status checks");
		expect(out.stderr.at(-1)).toContain("which checks block is UNKNOWN, never none.");
	});

	it("falls back to the denylist on a base branch that declares nothing required", async () => {
		const out = await run([
			[PULL, served(pull())],
			[RUNS, runs(1, [{name: "unit tests", status: "completed", conclusion: "failure"}])],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tred`);
		expect(out.stderr.join("\n")).toContain("declares no required status checks");
	});
});

describe("runCi", () => {
	it("prints the rollup, the run count, and one line per status present", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe([`ci\t${HEAD}\tgreen`, "run\t3", "check\tsuccess\t3", ""].join("\n"));
	});

	/**
	 * `checks` is an evidence-array collapsed to a status tally; what the rows were for
	 * — naming the red and in-flight runs — moves to the notes channel.
	 */
	it("names the failing and still-running runs on stderr, never as answer rows", async () => {
		const out = await run([
			[PULL, served(pull())],
			[
				RUNS,
				runs(3, [
					{name: "unit tests", status: "completed", conclusion: "failure"},
					{name: "leak-guard", status: "completed", conclusion: "success"},
					{name: "CodeQL", status: "in_progress", conclusion: null},
				]),
			],
		]);
		expect(out.stdout).toContain("\tred\n");
		expect(out.stdout).toContain("check\tfailure\t1");
		expect(out.stderr.join("\n")).toContain("review ci: failing at this head: unit tests.");
		expect(out.stderr.join("\n")).toContain("review ci: still running at this head: CodeQL.");
		expect(out.stdout).not.toContain("unit tests\tfailure");
	});

	it("enumerates at --sha and notices when the live head has moved past it", async () => {
		const out = await run(
			[
				[PULL, served(pull({head: HEAD}))],
				[COMMIT(OLD_HEAD), {status: 200, body: JSON.stringify({sha: OLD_HEAD})}],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
				[
					AT_HEAD,
					served(
						runsAtHead({path: CI_YML, headSha: OLD_HEAD}, {path: GUARD_YML, headSha: OLD_HEAD}),
					),
				],
			],
			{sha: OLD_HEAD},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${OLD_HEAD}\tgreen`);
		expect(out.stderr.join("\n")).toContain("the head moved");
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

	it("refuses zero declared check runs on 7 — a vacuous green is the fail-open", async () => {
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
			`review ci: received 1 of 9 declared check runs at ${HEAD} — refusing the partial enumeration.`,
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
	/** The live incident: a conflicted head where only CodeQL's default setup reported. */
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
			`review ci: none of the 2 workflow(s) o/r authors inspected ${HEAD} — the 4 check run(s) here came from elsewhere or from a run that opened another ref, so no gate inspected these bytes: the CI state is UNKNOWN, never green.`,
		);
	});

	it("answers when one authored run sits among the platform's — one gate is coverage", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, CODEQL_ONLY],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
				[AT_HEAD, served(runsAtHead(CI_YML, CODEQL))],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`ci\t${HEAD}\tgreen`);
		expect(out.stderr).toContain(`review ci: 1 of 2 workflow(s) o/r authors inspected ${HEAD}.`);
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

	it("refuses a head whose only repo-authored run opened the base ref", async () => {
		// The reported incident: a conflicted PR gets no `pull_request` run, and `pr-cleanup.yml` fires on
		// `pull_request_target`, which carries the head and checks out the base. Its path is inside
		// `.github/workflows/`, so the path alone reads as a gate that never opened a byte of this head.
		const out = await run(
			[
				[PULL, served(pull())],
				[
					RUNS,
					runs(2, [
						{name: "resolve app roster", status: "completed", conclusion: "success"},
						{name: "cleanup (web)", status: "completed", conclusion: "success"},
					]),
				],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CLEANUP_YML))],
				[AT_HEAD, served(runsAtHead({path: CLEANUP_YML, event: "pull_request_target"}))],
			],
		);
		expect(out.code).toBe(NO_GATE_COVERAGE);
		expect(out.stdout).toBe("");
	});

	it("covers a mixed head off the head-inspecting run beside the cleanup one", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CLEANUP_YML))],
				[AT_HEAD, served(runsAtHead({path: CLEANUP_YML, event: "pull_request_target"}, CI_YML))],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain(`review ci: 1 of 3 workflow(s) o/r authors inspected ${HEAD}.`);
	});

	it("judges an abbreviated --sha exactly as its full object name does", async () => {
		// The Actions run list filters `head_sha` as an exact string, so the abbreviation has to be
		// resolved before the read. This script answers only the full one: an abbreviation on the wire
		// matches nothing and the verb refuses on 11 instead of printing this green.
		const AT_FULL = new RegExp(`actions/runs\\?head_sha=${HEAD}`);
		const out = await run(
			[
				[PULL, served(pull())],
				[COMMIT("03135b91"), {status: 200, body: JSON.stringify({sha: HEAD})}],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
				[AT_FULL, served(runsAtHead(CI_YML, GUARD_YML))],
			],
			{sha: "03135b91"},
		);
		expect(out.code).toBe(0);
		// The answer still spells the commit the caller asked about; only the coverage read resolves it.
		expect(out.stdout.split("\n")[0]).toBe("ci\t03135b91\tgreen");
		expect(out.stderr).toContain(`review ci: 2 of 2 workflow(s) o/r authors inspected ${HEAD}.`);
	});

	it("reports an unresolvable head as UNKNOWN, never as a repo whose gates were silent", async () => {
		const out = await run(
			[
				[PULL, served(pull({head: "03135b91"}))],
				[RUNS, GREEN],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, GUARD_YML, CODEQL))],
				[AT_HEAD, served(runsAtHead(CI_YML))],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot judge gate coverage at 03135b91");
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
		expect(out.stderr).toContain(`review ci: 2 of 2 workflow(s) o/r authors inspected ${HEAD}.`);
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

	/** `checks` is a status histogram under `--json`, never a row per run. */
	it("collapses --json checks to a status tally beside the coverage", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, GREEN],
			],
			GATED,
			{json: true},
		);
		const payload = JSON.parse(out.stdout);
		expect(payload.checks).toEqual({success: 3});
		expect(payload.scanned).toBe(3);
		expect(out.stdout).not.toContain('"name"');
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
		expect(out.stdout).toBe([`ci\t${HEAD}\tno-producer`, "run\t0", ""].join("\n"));
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

/**
 * The bounded wait: a `pending` is the ordinary state of a PR minutes after a push, and a
 * caller that cannot wait for it has only a park on a human to offer for a condition that clears
 * itself. The verb owns the loop so no skill ever sleeps (`docs/skill-conventions.md` §14).
 */
describe("the bounded --wait", () => {
	const PENDING = runs(3, [
		{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
		{name: "unit tests", status: "queued", conclusion: null},
		{name: "leak-guard", status: "in_progress", conclusion: null},
	]);

	it("answers a pending head with this moment's read, and no settle token, without --wait", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, PENDING],
			],
			GATED,
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tpending`);
		expect(out.stdout).not.toContain("settle\t");
	});

	it("stays in the loop and settles on the head's own verdict once CI concludes", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[once(RUNS), PENDING],
				[RUNS, GREEN],
			],
			GATED,
			{wait: true, cadenceSeconds: 0},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n").slice(0, 2)).toEqual(["settle\tsettled", `ci\t${HEAD}\tgreen`]);
	});

	/**
	 * The whole point of the settle token: an exhausted bound must not read as a verdict. The rollup
	 * beside it is still `pending`, so nothing about the head was proven — the wait ran out.
	 */
	it("exhausts the bound on a head that never concludes, still pending and never green", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, PENDING],
			],
			GATED,
			{wait: true, cadenceSeconds: 0, budgetSeconds: 0},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n").slice(0, 2)).toEqual([
			"settle\tbudget-exhausted",
			`ci\t${HEAD}\tpending`,
		]);
		expect(out.stdout).not.toContain("green");
	});

	it("stops when the PR leaves the head this answer binds", async () => {
		const out = await run(
			[
				[once(PULL), served(pull())],
				[PULL, served(pull({head: OLD_HEAD}))],
				[RUNS, PENDING],
			],
			GATED,
			{wait: true, cadenceSeconds: 0},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n").slice(0, 2)).toEqual([
			"settle\thead-moved",
			`ci\t${HEAD}\tpending`,
		]);
	});

	/**
	 * The `16` head has nothing coming — no gate of this repo ran at it — so a wait would answer
	 * nothing. A cadence no test could sit through proves the refusal is taken on the first read.
	 */
	it("refuses an ungated head on 16 at once, without entering the loop", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, PENDING],
			],
			[
				[WORKFLOWS, served(inventory(CI_YML, CODEQL))],
				[AT_HEAD, served(runsAtHead(CODEQL))],
			],
			{wait: true, cadenceSeconds: 86_400},
		);
		expect(out.code).toBe(NO_GATE_COVERAGE);
		expect(out.stdout).toBe("");
	});

	/**
	 * The floor check-run stays `in_progress` until a governance verdict binds at the head,
	 * and the shell running this wait is the shell that owes that verdict. A cadence no
	 * test could sit through proves the answer comes on the first read.
	 */
	describe("a governance floor that is waiting on its own caller", () => {
		const FLOOR_PENDING = runs(3, [
			{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
			{name: "unit tests", status: "completed", conclusion: "success"},
			{name: CHECK_RUN_NAME, status: "in_progress", conclusion: null},
		]);
		const FLOOR_YML = ".github/workflows/governance-floor.yml";
		const floorRuns = (status: string): ReadonlyArray<Scripted> => [
			[WORKFLOWS, served(inventory(CI_YML, FLOOR_YML))],
			[AT_HEAD, served(runsAtHead(CI_YML, {path: FLOOR_YML, name: "governance-floor", status}))],
		];

		it("answers governance-owed at once when the floor's workflow run has completed", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, FLOOR_PENDING],
				],
				floorRuns("completed"),
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n").slice(0, 2)).toEqual([
				"settle\tgovernance-owed",
				`ci\t${HEAD}\tpending`,
			]);
			expect(out.stderr.join("\n")).toContain("a governance verdict bound at this head");
		});

		/** The floor has not published yet, so this one does clear on its own and is waited on. */
		it("waits on a floor whose own workflow run is still in flight, unchanged", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[once(RUNS), FLOOR_PENDING],
					[RUNS, GREEN],
				],
				[...floorRuns("in_progress"), ...GATED],
				{wait: true, cadenceSeconds: 0},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n").slice(0, 2)).toEqual(["settle\tsettled", `ci\t${HEAD}\tgreen`]);
			expect(out.stderr.join("\n")).not.toContain("governance verdict");
		});

		it("keeps waiting when something other than the floor is also pending", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, PENDING],
				],
				floorRuns("completed"),
				{wait: true, cadenceSeconds: 0, budgetSeconds: 0},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n")[0]).toBe("settle\tbudget-exhausted");
		});

		/**
		 * The other half. On a repair round the verdict is bound to the previous head, so
		 * the floor concludes `failure` rather than staying pending — the rollup is `red` and the verb
		 * returns at once. That red belongs to the shell reading it, and a reviewer taking it as the
		 * code class's execution evidence FAILs a PR over a floor it was about to clear.
		 */
		const floorRed = (title: string) =>
			runs(3, [
				{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
				{name: "unit tests", status: "completed", conclusion: "success"},
				{name: CHECK_RUN_NAME, status: "completed", conclusion: "failure", title},
			]);
		// Off the writer, never hand-copied: a third copy of the title would be the drift the whole
		// discriminator turns on, and it would drift silently green.
		const publishedTitle = (state: string) =>
			planFor(4321, {_tag: "Bound", state, sha: HEAD, scanned: 2, stderr: []}).title;
		const STALE_TITLE = publishedTitle("stale");
		const UNRESOLVED_TITLE = planFor(4321, {
			_tag: "Unresolved",
			outcome: {code: 11, stdout: "", stderr: ["unreadable"]},
		}).title;

		it("answers governance-stale on a red whose only failing check is a stale floor", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, floorRed(STALE_TITLE)],
				],
				floorRuns("completed"),
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n").slice(0, 2)).toEqual([
				"settle\tgovernance-stale",
				`ci\t${HEAD}\tred`,
			]);
			expect(out.stderr.join("\n")).toContain("This red is yours to clear");
		});

		/** The caller's own re-fire mid-republish — still its red, so still its token. */
		it("answers governance-stale while the floor's own re-fire is still in flight", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, floorRed(STALE_TITLE)],
				],
				floorRuns("in_progress"),
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.stdout.split("\n")[0]).toBe("settle\tgovernance-stale");
		});

		it("stays a plain red when anything else is failing beside the floor", async () => {
			const MIXED = runs(3, [
				{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
				{name: "unit tests", status: "completed", conclusion: "failure"},
				{name: CHECK_RUN_NAME, status: "completed", conclusion: "failure", title: STALE_TITLE},
			]);
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, MIXED],
				],
				[],
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n").slice(0, 2)).toEqual(["settle\tsettled", `ci\t${HEAD}\tred`]);
			expect(out.stderr.join("\n")).not.toContain("yours to clear");
		});

		/** UNKNOWN never passes, so it is never the reader's to discount either. */
		it("stays a plain red when the floor could not be resolved at all", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, floorRed(UNRESOLVED_TITLE)],
				],
				[],
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.code).toBe(0);
			expect(out.stdout.split("\n").slice(0, 2)).toEqual(["settle\tsettled", `ci\t${HEAD}\tred`]);
			expect(out.stderr.join("\n")).not.toContain("yours to clear");
		});

		it("stays a plain red when no floor run at the head vouches for the check", async () => {
			const out = await run(
				[
					[PULL, served(pull())],
					[RUNS, floorRed(STALE_TITLE)],
				],
				[[AT_HEAD, served(runsAtHead(CI_YML))]],
				{wait: true, cadenceSeconds: 86_400},
			);
			expect(out.stdout.split("\n")[0]).toBe("settle\tsettled");
		});
	});

	it("returns no-producer at once — a caller must not wait for a run that will never start", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[RUNS, runs(0, [])],
			],
			[[WORKFLOWS, served(workflows())]],
			{wait: true, cadenceSeconds: 86_400},
			{[CONFIG]: '{"ci": {"noProducer": "degrade"}}'},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe([`ci\t${HEAD}\tno-producer`, "run\t0", ""].join("\n"));
		expect(out.stdout).not.toContain("settle\t");
	});
});
