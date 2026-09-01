import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {workflows} from "../ship/fixtures.test-support.ts";
import {CHECK_RUN_NAME} from "../ship/floor-check.ts";
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
			Layer.merge(fakeSeams([...script, ...http]).layer, fakeFs({files}).layer),
		),
	);

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
	 * ADR 0308: `checks` is an evidence-array collapsed to a status tally; what the rows were for
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
			`review ci: none of the 2 workflow(s) o/r authors produced a run at ${HEAD} — the 4 check run(s) here came from elsewhere, so no gate inspected these bytes: the CI state is UNKNOWN, never green (#6522).`,
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
		expect(out.stderr).toContain(
			`review ci: 1 of 2 workflow(s) o/r authors produced a run at ${HEAD}.`,
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

	/** ADR 0308: `checks` is a status histogram under `--json`, never a row per run. */
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
 * The bounded wait of #7282: a `pending` is the ordinary state of a PR minutes after a push, and a
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
	 * #7392: the floor check-run stays `in_progress` until a governance verdict binds at the head
	 * (ADR 0318), and the shell running this wait is the shell that owes that verdict. A cadence no
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
