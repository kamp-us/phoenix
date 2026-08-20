import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {workflows} from "../ship/fixtures.test-support.ts";
import {runCi} from "./ci-verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {checkRuns, HEAD, OLD_HEAD, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const COMMIT = (sha: string) => new RegExp(`^gh api repos/o/r/commits/${sha} --jq \\.sha$`);
const RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const WORKFLOWS = /^gh api --paginate repos\/o\/r\/actions\/workflows/;
const CONFIG = "/repo/.fabrika.jsonc";

const GREEN = checkRuns(3, [
	{name: "lint / format / typecheck", status: "completed", conclusion: "success"},
	{name: "unit tests", status: "completed", conclusion: "success"},
	{name: "leak-guard", status: "completed", conclusion: "success"},
]);

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: "/repo",
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runCi({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeFs({files}).layer),
		),
	);

describe("runCi", () => {
	it("prints the rollup, the count of lines that follow, and one line per run", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, GREEN],
		]);
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
			[PULL, pull()],
			[
				RUNS,
				checkRuns(2, [
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
				[PULL, pull({head: HEAD})],
				[COMMIT(OLD_HEAD), okOut(OLD_HEAD)],
				[RUNS, GREEN],
			],
			{sha: OLD_HEAD},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${OLD_HEAD}\tgreen`);
		expect(out.stderr[0]).toContain("the head moved");
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMIT(OLD_HEAD), errOut("gh: Not Found (HTTP 404)")],
			],
			{sha: OLD_HEAD},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(`review ci: no commit ${OLD_HEAD} on PR #4321 in o/r.`);
	});

	it("refuses zero declared check runs on 7 — a vacuous green is the ADR 0092 fail-open", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, checkRuns(0, [])],
			[WORKFLOWS, workflows("active", "active")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing to report green over an empty enumeration");
	});

	it("refuses a short enumeration on 13 — never read as `no red checks`", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, checkRuns(9, [{name: "unit tests", status: "completed", conclusion: "success"}])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review ci: received 1 of 9 declared check runs at ${HEAD} — refusing the partial enumeration (#3999).`,
		);
	});

	it("refuses an unreadable enumeration on 11 — CI state is UNKNOWN, never green", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("CI state is UNKNOWN, never green");
	});

	it("reports what it scanned against what was declared", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, GREEN],
		]);
		expect(out.stderr).toContain("review ci: scanned 3 check runs; 3 declared.");
	});
});

describe("the no-producer split", () => {
	const empty: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		[RUNS, checkRuns(0, [])],
	];

	it("never asks the producer question while checks are reporting", async () => {
		// No WORKFLOWS entry in the script: a call would fail the fake, which is the assertion.
		const out = await run([
			[PULL, pull()],
			[RUNS, GREEN],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses zero workflows on 7 by default — no producer, so no head can be evidenced", async () => {
		const out = await run([...empty, [WORKFLOWS, workflows()]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("zero workflows — no CI producer");
	});

	it("rolls up no-producer, never green, when the repo declares degrade", async () => {
		const out = await run(
			[...empty, [WORKFLOWS, workflows()]],
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
			[...empty, [WORKFLOWS, workflows()]],
			{},
			{
				[CONFIG]: '{"ci": {"noProducer": "ignore"}}',
			},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is not one of refuse, degrade");
	});

	it("refuses an unreadable workflow inventory on 11 — never `no producer`", async () => {
		const out = await run([...empty, [WORKFLOWS, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("whether a producer exists is UNKNOWN, never green");
	});
});
