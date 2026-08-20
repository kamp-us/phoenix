import {Effect, type FileSystem, Layer, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeHttp,
	fakeShell,
	type HttpReply,
	linkNext,
	okOut,
	unconfigured,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDiagnose} from "./diagnose-verb.ts";
import {
	COMMENTS,
	COMMIT_DATE,
	COMMIT_EXISTS,
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
	reviews,
	rules,
	runsTotal,
	timeline,
	unexhaustedPage,
	workflows,
} from "./fixtures.test-support.ts";

// The reads `ship/github.ts` carries went over to HTTP (ADR 0315); `heal-ci/github.ts`'s own reads
// — the commit date, the branch protection surface — still shell out, as do `io/`'s.
const API = "https://api\\.github\\.com/repos/o/r";
const CHECK_RUNS = new RegExp(`^GET ${API}/commits/[0-9a-f]+/check-runs`);
const WORKFLOWS = new RegExp(`^GET ${API}/actions/workflows\\?`);
const RUN_COUNT = new RegExp(`^GET ${API}/actions/runs\\?head_sha=[0-9a-f]+&per_page=1$`);
const RULES = new RegExp(`^GET ${API}/rules/branches/main`);
const TIMELINE = new RegExp(`^GET ${API}/issues/4321/timeline`);
const REVIEWS = new RegExp(`^GET ${API}/pulls/4321/reviews`);
const COMPARE = new RegExp(`^GET ${API}/compare/main\\.\\.\\.[0-9a-f]+$`);

/** An envelope payload, served as the body of the 200 the ported read now issues. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

/**
 * A `gh api -i` fixture, re-served as the HTTP reply its bytes describe.
 *
 * The `Link` header the fixture declared is the completeness proof either way — the transport reads
 * it off the response now instead of out of a printed status line — so the fixtures stay the one
 * source for these payloads rather than being copied into this file at a second shape.
 */
const paged = (result: ExecResult): HttpReply => {
	const at = result.stdout.indexOf("\r\n\r\n");
	const headers = result.stdout.slice(0, at);
	const body = result.stdout.slice(at + 4);
	const next = /link: <([^>]*)>; rel="next"/.exec(headers)?.[1];
	return next === undefined ? {status: 200, body} : {status: 200, body, headers: linkNext(next)};
};

/** How far the inspected head sits behind its base, as the compare endpoint reports it. */
const behind = (by: number): HttpReply => ({status: 200, body: JSON.stringify({behind_by: by})});

const gone = (status: number, message: string): HttpReply => ({
	status,
	body: JSON.stringify({message}),
});

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

const green = (name = "ci-required") => ({name, status: "completed", conclusion: "success"});

/** The HTTP-served half of the happy read set. Cases override the row they are about. */
const api = (
	overrides: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	...overrides,
	[CHECK_RUNS, served(checkRuns(1, [green()]))],
	[WORKFLOWS, served(workflows("active"))],
	[RUN_COUNT, served(runsTotal(3))],
	[RULES, paged(rules("ci-required"))],
	[TIMELINE, paged(timeline())],
	[REVIEWS, paged(reviews())],
	[COMPARE, behind(0)],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = api(),
	overrides: Partial<typeof options> = {},
) => runWith(script, http, unconfigured, overrides);

/** The same run against a repo that declared something — the config arm `unconfigured` cannot reach. */
const runWith = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]>,
	config: Layer.Layer<FileSystem.FileSystem | Path.Path>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDiagnose({...options, ...overrides}),
			Layer.mergeAll(fakeShell(script).layer, fakeHttp(http).layer, config),
		),
	);

/** The `gh`-served half of the happy read set. Cases override the row they are about. */
const script = (
	overrides: ReadonlyArray<readonly [RegExp, ExecResult]> = [],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	...overrides,
	[PULL, pull({updatedAt: PUSHED})],
	[FILES, files("apps/web/worker/a.ts", "apps/web/worker/b.ts")],
	[COMMIT_DATE, commitDate(PUSHED)],
	[PROTECTION, protection()],
	[COMMENTS, comments()],
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
			script(),
			api([
				[
					CHECK_RUNS,
					served(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
				],
			]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tred\t${HEAD}\t35`);
	});

	it("reports check-surface above red when a required context has no producing run", async () => {
		const out = await run(
			script(),
			api([
				[RULES, paged(rules("ci-required", "code-scanning/codeql"))],
				[
					CHECK_RUNS,
					served(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
				],
			]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tcheck-surface\t${HEAD}\t35`);
	});

	it("skips the surface arm on an unprobeable protection surface rather than passing it", async () => {
		const out = await run(
			script(),
			api([
				[RULES, gone(403, "Must have admin rights to Repository collaborators.")],
				[
					CHECK_RUNS,
					served(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
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
			script(),
			api([
				[CHECK_RUNS, served(checkRuns(0, []))],
				[RUN_COUNT, served(runsTotal(0))],
			]),
		);
		expect(noRuns.stdout).toContain("ci\tno-runs\t0");
		const noCi = await runWith(
			script(),
			api([
				[CHECK_RUNS, served(checkRuns(0, []))],
				[WORKFLOWS, served(workflows())],
				[RUN_COUNT, served(runsTotal(0))],
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
			script(),
			api([
				[CHECK_RUNS, served(checkRuns(0, []))],
				[WORKFLOWS, served(workflows())],
				[RUN_COUNT, served(runsTotal(0))],
			]),
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("zero workflows");
	});

	it("refuses zero workflows as UNKNOWN when the config itself could not be decoded", async () => {
		const out = await runWith(
			script(),
			api([
				[CHECK_RUNS, served(checkRuns(0, []))],
				[WORKFLOWS, served(workflows())],
				[RUN_COUNT, served(runsTotal(0))],
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
		const out = await run(script(), api([[CHECK_RUNS, gone(502, "Bad gateway")]]));
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
		const out = await run(script(), api([[TIMELINE, paged(unexhaustedPage())]]));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("never reached a terminal page");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run(script([[PULL, errOut("gh: Not Found (HTTP 404)")]]));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("heal-ci diagnose: PR #4321 not found in o/r.");
	});

	it("refuses a --sha this PR never had on 7", async () => {
		const out = await run(script([[COMMIT_EXISTS, errOut("gh: Not Found (HTTP 404)")]]), api(), {
			sha: "deadbee",
		});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("refusing to classify a tree this PR never had");
	});

	it("refuses a malformed --sha as a usage error, never as a wildcard", async () => {
		const out = await run(script(), api(), {sha: "zz"});
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
