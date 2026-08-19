import {Effect, type FileSystem, Layer, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDiagnose} from "./diagnose-verb.ts";
import {
	behind,
	CHECK_RUNS,
	COMMENTS,
	COMMIT_DATE,
	COMMIT_EXISTS,
	COMPARE,
	checkRuns,
	comments,
	commitDate,
	ENV,
	FILES,
	files,
	HEAD,
	PERMISSION,
	PROTECTION,
	PULL,
	permission,
	protection,
	pull,
	REVIEWS,
	RULES,
	RUN_COUNT,
	reviews,
	rules,
	runsTotal,
	TIMELINE,
	timeline,
	unexhaustedPage,
	WORKFLOWS,
	workflows,
} from "./fixtures.test-support.ts";

const NOW = Date.parse("2026-08-08T01:00:00Z");
const PUSHED = "2026-08-08T00:25:00Z";

const options = {
	pr: 4321,
	sha: "",
	dwellMinutes: 45,
	wedgeDwellMinutes: 20,
	driftCommits: 10,
	repo: null,
	json: false,
	cwd: "/repo",
	env: ENV,
	now: NOW,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDiagnose({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, unconfigured),
		),
	);

/** The same run against a repo that declared something — the config arm `unconfigured` cannot reach. */
const runWith = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	config: Layer.Layer<FileSystem.FileSystem | Path.Path>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDiagnose({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, config),
		),
	);

const green = (name = "ci-required") => ({name, status: "completed", conclusion: "success"});

/** The whole happy read set, in the order the verb walks it. Cases override the row they are about. */
const script = (
	overrides: ReadonlyArray<readonly [RegExp, ExecResult]> = [],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	...overrides,
	[PULL, pull({updatedAt: PUSHED})],
	[FILES, files("apps/web/worker/a.ts", "apps/web/worker/b.ts")],
	[CHECK_RUNS, checkRuns(1, [green()])],
	[WORKFLOWS, workflows("active")],
	[RUN_COUNT, runsTotal(3)],
	[COMMIT_DATE, commitDate(PUSHED)],
	[RULES, rules("ci-required")],
	[PROTECTION, protection()],
	[COMMENTS, comments()],
	[TIMELINE, timeline()],
	[REVIEWS, reviews()],
	[COMPARE, behind(0)],
	[COMMIT_EXISTS, okOut(HEAD)],
	[PERMISSION, permission("write")],
];

describe("runDiagnose answers", () => {
	it("prints the class, the head, the age and every evidence line, always", async () => {
		const out = await run(script());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`stall\tungated\t${HEAD}\t35`,
				"owner\t-\t-\t2026-08-08T00:25:00Z",
				"gates\tblocked\t0/1",
				"ci\tgreen\t0",
				"queue\tnone",
				"link\tfixes:4287",
				"facts\tscanned-comments:0\tscanned-checks:1\tbehind-base:0",
				"",
			].join("\n"),
		);
	});

	it("reads a red gating rollup as `red`, an answer at exit 0", async () => {
		const out = await run(
			script([
				[
					CHECK_RUNS,
					checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}]),
				],
			]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tred\t${HEAD}\t35`);
	});

	it("reports check-surface above red when a required context has no producing run", async () => {
		const out = await run(
			script([
				[RULES, rules("ci-required", "code-scanning/codeql")],
				[
					CHECK_RUNS,
					checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}]),
				],
			]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tcheck-surface\t${HEAD}\t35`);
	});

	it("skips the surface arm on an unprobeable protection surface rather than passing it", async () => {
		const out = await run(
			script([
				[RULES, errOut("gh: Must have admin rights (HTTP 403)")],
				[
					CHECK_RUNS,
					checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}]),
				],
			]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tred\t${HEAD}\t35`);
		expect(out.stderr.join("\n")).toContain("UNPROBEABLE");
	});

	it("declares arm 6's unimplemented half on stderr rather than letting the class read whole", async () => {
		const out = await run(script([[PULL, pull({assignees: ["usirin"]})]]));
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("UNIMPLEMENTED");
		expect(out.stderr.join("\n")).toContain("derived from reviews alone");
	});

	it("reads an assignee whose activity is inside the dwell as attended, not as a strand", async () => {
		const out = await run(
			script([[PULL, pull({assignees: ["usirin"], updatedAt: "2026-08-08T00:55:00Z"})]]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tattended\t${HEAD}\t5`);
	});

	it("reads an assignee gone quiet past the dwell as claim-stale, naming why", async () => {
		const out = await run(
			script([[PULL, pull({assignees: ["usirin"], updatedAt: "2026-08-07T20:00:00Z"})]]),
		);
		expect(out.stdout.split("\n")[0]).toContain("claim-stale");
		expect(out.stderr.join("\n")).toContain("claim-stale fired on inactivity");
	});

	it("reads a draft as not-open — an answer, not a refusal", async () => {
		const out = await run(script([[PULL, pull({draft: true, updatedAt: PUSHED})]]));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toContain("not-open");
	});

	it("keeps the two zero-signal CI tokens apart", async () => {
		const noRuns = await run(
			script([
				[CHECK_RUNS, checkRuns(0, [])],
				[RUN_COUNT, runsTotal(0)],
			]),
		);
		expect(noRuns.stdout).toContain("ci\tno-runs\t0");
		const noCi = await runWith(
			script([
				[CHECK_RUNS, checkRuns(0, [])],
				[WORKFLOWS, workflows()],
				[RUN_COUNT, runsTotal(0)],
			]),
			fakeFs({files: {"/repo/.fabrika.jsonc": '{"ci": {"noProducer": "degrade"}}'}}).layer,
		);
		expect(noCi.stdout).toContain("ci\tnone\t0");
	});

	// The `none` token is the degrade answer, so a repo that never declared `ci.noProducer` may not
	// be handed it — `review ci` and `ship checks` make the same repo declare the opt-out, and a
	// third compiled-in reading here is how the three drift apart.
	it("refuses zero workflows rather than reading `none` off a repo that declared nothing", async () => {
		const out = await run(
			script([
				[CHECK_RUNS, checkRuns(0, [])],
				[WORKFLOWS, workflows()],
				[RUN_COUNT, runsTotal(0)],
			]),
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("zero workflows");
	});

	it("refuses zero workflows as UNKNOWN when the config itself could not be decoded", async () => {
		const out = await runWith(
			script([
				[CHECK_RUNS, checkRuns(0, [])],
				[WORKFLOWS, workflows()],
				[RUN_COUNT, runsTotal(0)],
			]),
			fakeFs({files: {"/repo/.fabrika.jsonc": '{"ci": {"noProducer": "maybe"}}'}}).layer,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN, never green");
	});
});

describe("runDiagnose refuses rather than guessing a class", () => {
	it("refuses an unreadable check-run read on 11 — never `attended`", async () => {
		const out = await run(script([[CHECK_RUNS, errOut("gh: Bad gateway (HTTP 502)")]]));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "attended"');
	});

	it("refuses a short comment enumeration on 13", async () => {
		const out = await run(
			script([
				[PULL, pull({comments: 9, updatedAt: PUSHED})],
				[COMMENTS, comments()],
			]),
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unexhausted timeline read on 13 — a queue entry could sit on an unread page", async () => {
		const out = await run(script([[TIMELINE, unexhaustedPage()]]));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("never reached a terminal page");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run(script([[PULL, errOut("gh: Not Found (HTTP 404)")]]));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("heal-ci diagnose: PR #4321 not found in o/r.");
	});

	it("refuses a --sha this PR never had on 7", async () => {
		const out = await run(script([[COMMIT_EXISTS, errOut("gh: Not Found (HTTP 404)")]]), {
			sha: "deadbee",
		});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("refusing to classify a tree this PR never had");
	});

	it("refuses a malformed --sha as a usage error, never as a wildcard", async () => {
		const out = await run(script(), {sha: "zz"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable ACL on 11 rather than dropping the verdict it gates", async () => {
		const out = await run(
			script([
				[PULL, pull({comments: 1, updatedAt: PUSHED})],
				[COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — the ACs are met.`})],
				[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
			]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});
});
