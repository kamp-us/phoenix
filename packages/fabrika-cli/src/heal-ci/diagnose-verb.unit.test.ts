import {Effect, type FileSystem, Layer, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {
	fakeFs,
	fakeSeams,
	type HttpReply,
	linkNext,
	type Scripted,
	unconfigured,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDiagnose} from "./diagnose-verb.ts";
import {
	COMMIT_DATE,
	checkRuns,
	comments,
	ENV,
	files,
	HEAD,
	httpError,
	OTHER_HEAD,
	PROTECTION,
	protection,
	pull,
	RULES,
	rules,
	runsTotal,
	workflows,
} from "./fixtures.test-support.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const FILES = /^GET .*\/repos\/o\/r\/pulls\/4321\/files\?/;
const CHECK_RUNS = /^GET .*\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const WORKFLOWS = /^GET .*\/repos\/o\/r\/actions\/workflows\?/;
const RUN_COUNT = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=[0-9a-f]+&per_page=1$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4321\/comments\?/;
const TIMELINE = /^GET .*\/repos\/o\/r\/issues\/4321\/timeline\?/;
const REVIEWS = /^GET .*\/repos\/o\/r\/pulls\/4321\/reviews\?/;
const COMPARE = /^GET .*\/repos\/o\/r\/compare\/main\.\.\.[0-9a-f]+$/;
const PERMISSION = /^GET .*\/repos\/o\/r\/collaborators\/\S+\/permission$/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/** An empty bare-array page — no `Link`, so the walk is proven exhausted. */
const emptyPage: HttpReply = {status: 200, body: "[]"};

/**
 * The commit payload, carrying both fields read off it: `commitExists` wants `sha` and
 * `commitPushedAt` wants the committer date, and the two calls hit the one endpoint.
 */
const commit = (at: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({sha: HEAD, commit: {committer: {date: at}}}),
});

const behind = (by: number): HttpReply => ({status: 200, body: JSON.stringify({behind_by: by})});

const permission = (level: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({permission: level}),
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

/** The whole happy read set, in the order the verb walks it. Cases override the row they are about. */
const script = (overrides: ReadonlyArray<Scripted> = []): ReadonlyArray<Scripted> => [
	...overrides,
	[PULL, reply(pull({updatedAt: PUSHED}))],
	[FILES, reply(files("apps/web/worker/a.ts", "apps/web/worker/b.ts"))],
	[CHECK_RUNS, reply(checkRuns(1, [green()]))],
	[WORKFLOWS, reply(workflows("active"))],
	[RUN_COUNT, reply(runsTotal(3))],
	[COMMENTS, reply(comments())],
	[TIMELINE, emptyPage],
	[REVIEWS, emptyPage],
	[COMPARE, behind(0)],
	[COMMIT_DATE, commit(PUSHED)],
	[PERMISSION, permission("write")],
	[RULES, rules("ci-required")],
	[PROTECTION, protection()],
];

const run = (rows: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runDiagnose({...options, ...overrides}),
			Layer.mergeAll(fakeSeams(rows).layer, unconfigured),
		),
	);

/** The same run against a repo that declared something — the config arm `unconfigured` cannot reach. */
const runWith = (
	rows: ReadonlyArray<Scripted>,
	config: Layer.Layer<FileSystem.FileSystem | Path.Path>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDiagnose({...options, ...overrides}),
			Layer.mergeAll(fakeSeams(rows).layer, config),
		),
	);

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

	// #6376: this verb is the second resolver of the same question `ship gate` answers. A PR the
	// gate calls satisfied must not classify `ungated` here, or the healer dispatches it back to a
	// review whose namespace no sanctioned path can fill — the loop the route exists to close.
	it("counts a head-bound routed-elsewhere record as a filled review-ui namespace", async () => {
		const out = await run(
			script([
				[PULL, reply(pull({updatedAt: PUSHED, comments: 2, changedFiles: 1}))],
				[FILES, reply(files("apps/web/src/flags/shell-keys.ts"))],
				[
					COMMENTS,
					reply(
						comments(
							{id: 1, body: `review-code: PASS @ ${HEAD} — the clause`},
							{
								id: 2,
								body: `routed-elsewhere: review-ui @ ${HEAD} — no rendered delta; the diff is prose only`,
							},
						),
					),
				],
			]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("gates\tsatisfied\t2/2");
		expect(out.stdout).not.toContain("ungated");
	});

	it("re-opens the namespace when the route binds a head that has moved", async () => {
		const out = await run(
			script([
				[PULL, reply(pull({updatedAt: PUSHED, comments: 2, changedFiles: 1}))],
				[FILES, reply(files("apps/web/src/flags/shell-keys.ts"))],
				[
					COMMENTS,
					reply(
						comments(
							{id: 1, body: `review-code: PASS @ ${HEAD} — the clause`},
							{
								id: 2,
								body: `routed-elsewhere: review-ui @ ${OTHER_HEAD} — no rendered delta; the diff is prose only`,
							},
						),
					),
				],
			]),
		);
		expect(out.stdout).toContain("gates\tblocked\t1/2");
	});

	// The gate admits the record for `review-ui` alone; a route aimed anywhere else resolves nothing,
	// or a session could decline any gate it liked.
	it("drops a route aimed at a namespace other than review-ui", async () => {
		const out = await run(
			script([
				[PULL, reply(pull({updatedAt: PUSHED, comments: 1}))],
				[
					COMMENTS,
					reply(
						comments({
							id: 1,
							body: `routed-elsewhere: review-code @ ${HEAD} — no rendered delta; the diff is prose only`,
						}),
					),
				],
			]),
		);
		expect(out.stdout).toContain("gates\tblocked\t0/1");
	});

	it("reads a red gating rollup as `red`, an answer at exit 0", async () => {
		const out = await run(
			script([
				[
					CHECK_RUNS,
					reply(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
				],
			]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tred\t${HEAD}\t35`);
	});

	it("reports check-surface above red when a required context has no producing run", async () => {
		const out = await run(
			script([
				[
					CHECK_RUNS,
					reply(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
				],
				[RULES, rules("ci-required", "code-scanning/codeql")],
			]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tcheck-surface\t${HEAD}\t35`);
	});

	it("skips the surface arm on an unprobeable protection surface rather than passing it", async () => {
		const out = await run(
			script([
				[
					CHECK_RUNS,
					reply(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "failure"}])),
				],
				[RULES, httpError(403, "Must have admin rights")],
			]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tred\t${HEAD}\t35`);
		expect(out.stderr.join("\n")).toContain("UNPROBEABLE");
	});

	it("declares arm 6's unimplemented half on stderr rather than letting the class read whole", async () => {
		const out = await run(script([[PULL, reply(pull({assignees: ["usirin"]}))]]));
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("UNIMPLEMENTED");
		expect(out.stderr.join("\n")).toContain("derived from reviews alone");
	});

	it("reads an assignee whose activity is inside the dwell as attended, not as a strand", async () => {
		const out = await run(
			script([[PULL, reply(pull({assignees: ["usirin"], updatedAt: "2026-08-08T00:55:00Z"}))]]),
		);
		expect(out.stdout.split("\n")[0]).toBe(`stall\tattended\t${HEAD}\t5`);
	});

	it("reads an assignee gone quiet past the dwell as claim-stale, naming why", async () => {
		const out = await run(
			script([[PULL, reply(pull({assignees: ["usirin"], updatedAt: "2026-08-07T20:00:00Z"}))]]),
		);
		expect(out.stdout.split("\n")[0]).toContain("claim-stale");
		expect(out.stderr.join("\n")).toContain("claim-stale fired on inactivity");
	});

	it("reads a draft as not-open — an answer, not a refusal", async () => {
		const out = await run(script([[PULL, reply(pull({draft: true, updatedAt: PUSHED}))]]));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toContain("not-open");
	});

	it("keeps the two zero-signal CI tokens apart", async () => {
		const noRuns = await run(
			script([
				[CHECK_RUNS, reply(checkRuns(0, []))],
				[RUN_COUNT, reply(runsTotal(0))],
			]),
		);
		expect(noRuns.stdout).toContain("ci\tno-runs\t0");
		const noCi = await runWith(
			script([
				[CHECK_RUNS, reply(checkRuns(0, []))],
				[WORKFLOWS, reply(workflows())],
				[RUN_COUNT, reply(runsTotal(0))],
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
				[CHECK_RUNS, reply(checkRuns(0, []))],
				[WORKFLOWS, reply(workflows())],
				[RUN_COUNT, reply(runsTotal(0))],
			]),
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("zero workflows");
	});

	it("refuses zero workflows as UNKNOWN when the config itself could not be decoded", async () => {
		const out = await runWith(
			script([
				[CHECK_RUNS, reply(checkRuns(0, []))],
				[WORKFLOWS, reply(workflows())],
				[RUN_COUNT, reply(runsTotal(0))],
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
		const out = await run(script([[CHECK_RUNS, httpError(502, "Bad gateway")]]));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "attended"');
	});

	it("refuses a short comment enumeration on 13", async () => {
		const out = await run(
			script([
				[PULL, reply(pull({comments: 9, updatedAt: PUSHED}))],
				[COMMENTS, reply(comments())],
			]),
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unexhausted timeline read on 13 — a queue entry could sit on an unread page", async () => {
		const out = await run(
			script([[TIMELINE, {...emptyPage, headers: linkNext("https://api.github.com/next")}]]),
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("never reached a terminal page");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run(script([[PULL, httpError(404, "Not Found")]]));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("heal-ci diagnose: PR #4321 not found in o/r.");
	});

	it("refuses a --sha this PR never had on 7", async () => {
		const out = await run(script([[COMMIT_DATE, httpError(404, "Not Found")]]), {
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
				[PULL, reply(pull({comments: 1, updatedAt: PUSHED}))],
				[
					COMMENTS,
					reply(comments({id: 1, body: `review-code: PASS @ ${HEAD} — the ACs are met.`})),
				],
				[PERMISSION, httpError(502, "Bad gateway")],
			]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});
});
