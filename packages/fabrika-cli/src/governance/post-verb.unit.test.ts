import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, okOut, once, type Scripted, unconfigured} from "../fakes.test-support.ts";
import {
	accepted,
	checkRuns,
	HEAD_CHECK_RUNS,
	RERUN_ALL as RERUN,
	RUN,
	runsAtHead,
	workflowRun,
} from "../heal-ci/fixtures.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {CONTENT, PATHS_AT} from "../review/fixtures.test-support.ts";
import {CHECK_RUN_NAME} from "../ship/floor-check.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NOT_HARNESS_TOUCHING,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {binding, comments, HEAD, OLD_HEAD, paths, pull} from "./fixtures.test-support.ts";
import {runPost} from "./post-verb.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const VIEWER = /^GET .*\/user$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4321\/comments/;
const CREATE = /^POST .*\/repos\/o\/r\/issues\/4321\/comments$/;
const PATCH = /^PATCH .*\/repos\/o\/r\/issues\/comments\/77$/;
const READ_BACK = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;
const RUNS = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=/;
const FLOOR = 31_863_008_185;

const BODY = "The sweep found no contradiction; no anchored invariant is in reach.\n";
const URL = "https://github.com/o/r/pull/4321#issuecomment-5154902211";

/** A fixture's canned JSON, served as the 200 the REST read now parses. */
const served = (result: ExecResult) => ({status: 200, body: result.stdout});

const options = {
	pr: 4321,
	polarity: "PASS",
	sha: HEAD,
	clause: "no contradiction, no weakening",
	base: null,
	tip: null,
	repo: null,
	json: false,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed({_tag: "Text", text: BODY} as StdinRead),
};

const layerFor = (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	return {seams, layer: Layer.mergeAll(seams.layer, unconfigured)};
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runPost({...options, ...overrides}), layerFor(script).layer));

const composed = (body = BODY, sha = HEAD): string =>
	`governance: PASS @ ${sha} content:${CONTENT} — no contradiction, no weakening\n\n${body}`;

const created = (id = 91): ExecResult => okOut(JSON.stringify({id, html_url: URL}));

const governing = (...extra: ReadonlyArray<Scripted>): ReadonlyArray<Scripted> => [
	[PULL, served(pull())],
	...binding(),
	[PATHS_AT(), paths(".decisions/0240-x.md", "src/cart.ts")],
	[VIEWER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
	[COMMENTS, served(comments())],
	...extra,
];

describe("runPost", () => {
	it("composes the marker, upserts one comment, reads it back, and prints the line", async () => {
		const out = await run(
			governing(
				[CREATE, {status: 201, body: created().stdout}],
				[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`posted\tgovernance\tPASS\t${HEAD}\t${CONTENT}\tcreated\t${URL}\n`);
	});

	// `composed()` defaults to HEAD, and that is load-bearing: the upsert key carries a head
	// dimension, so only a re-post at the SAME head takes the edit path at all.
	it("edits the namespace's own comment rather than stacking a second one", async () => {
		const out = await run([
			[PULL, served(pull())],
			...binding(),
			[PATHS_AT(), paths(".decisions/0240-x.md", "src/cart.ts")],
			[VIEWER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, served(comments({id: 77, body: composed("older\n")}))],
			[PATCH, {status: 200, body: JSON.stringify({html_url: URL})}],
			[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
		]);
		expect(out.stdout).toContain("\tedited\t");
	});

	// The head dimension of the upsert key. It shipped in v1 under #4007 and this tree did not carry
	// it forward, so a re-gate after a repair PATCHed the prior head's verdict away and the record of
	// what was true over that tree became unrecoverable (#5585).
	it("leaves a prior head's verdict intact and appends at the new head", async () => {
		const {seams, layer} = layerFor([
			[PULL, served(pull())],
			...binding(),
			[PATHS_AT(), paths(".decisions/0240-x.md", "src/cart.ts")],
			[VIEWER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[
				COMMENTS,
				served(comments({id: 77, body: composed("the round before the repair\n", OLD_HEAD)})),
			],
			[CREATE, {status: 201, body: created().stdout}],
			[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tcreated\t");
		expect(seams.requests.some((call) => PATCH.test(call))).toBe(false);
	});

	it("emits the record with --json, naming the fixed namespace", async () => {
		const out = await run(
			governing(
				[CREATE, {status: 201, body: created().stdout}],
				[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
			),
			{json: true},
		);
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "posted",
			namespace: "governance",
			polarity: "PASS",
			upsert: "created",
		});
	});

	it("refuses on 14 when the diff derives NO governance root, and writes nothing", async () => {
		const {seams, layer} = layerFor([
			[PULL, served(pull())],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), layer));
		expect(out.code).toBe(NOT_HARNESS_TOUCHING);
		expect(out.code).not.toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("a verdict in it would attest a scope nobody derived");
		expect(seams.requests.filter((call) => call.startsWith("POST"))).toEqual([]);
	});

	it("refuses a stale --sha on 12 before it writes anything", async () => {
		const out = await run(governing(), {sha: OLD_HEAD});
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stderr.at(-1)).toContain("re-review at");
	});

	it("refuses a bad polarity, a bad sha and a blank clause on 10", async () => {
		expect((await run(governing(), {polarity: "APPROVED"})).code).toBe(OFF_VOCABULARY);
		expect((await run(governing(), {sha: "origin/main"})).code).toBe(OFF_VOCABULARY);
		expect((await run(governing(), {clause: "   "})).code).toBe(OFF_VOCABULARY);
	});

	it("refuses an empty pipe on 3 and a bare @ body on 6", async () => {
		const empty = await run(governing(), {stdin: Effect.succeed({_tag: "Text", text: "  "})});
		expect(empty.code).toBe(EMPTY_STDIN);
		const bare = await run(governing(), {
			stdin: Effect.succeed({_tag: "Text", text: "@notes/verdict.md"}),
		});
		expect(bare.code).toBe(BARE_AT_PATH);
	});

	it("separates an UNREAD pipe from an empty one — 1, never 3", async () => {
		const out = await run(governing(), {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"}),
		});
		expect(out.code).toBe(1);
		expect(out.code).not.toBe(EMPTY_STDIN);
	});

	it("refuses a machine-local path in the ASSEMBLED comment on 5", async () => {
		const out = await run(governing(), {
			stdin: Effect.succeed({_tag: "Text", text: "see ~/notes/verdict.md for the sweep\n"}),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
	});

	it("refuses an absent or closed PR on 7", async () => {
		expect((await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]])).code).toBe(
			ZERO_SCOPE,
		);
		expect((await run([[PULL, served(pull({state: "closed"}))]])).code).toBe(ZERO_SCOPE);
	});

	it("seats a failed write on 8, never on 1 — the outcome is UNKNOWN", async () => {
		const out = await run(governing([CREATE, {status: 504, body: "{}"}]));
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.code).not.toBe(1);
		expect(out.stderr.at(-1)).toContain("UNKNOWN whether the verdict landed");
	});

	it("seats a read-back that does not carry the marker on 9", async () => {
		const out = await run(
			governing(
				[CREATE, {status: 201, body: created().stdout}],
				[READ_BACK, {status: 200, body: JSON.stringify({body: "thanks!\n"})}],
			),
		);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("inspect comment 91");
	});

	it("seats an unreadable precondition on 11 — nothing was posted", async () => {
		const out = await run([[PULL, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was posted");
	});

	it("re-reads the comment from live state — the write call's own echo is not evidence", async () => {
		const {seams, layer} = layerFor(
			governing(
				[once(CREATE), {status: 201, body: created().stdout}],
				[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
			),
		);
		await Effect.runPromise(Effect.provide(runPost(options), layer));
		expect(seams.requests).toContain("GET https://api.github.com/repos/o/r/issues/comments/91");
	});
});

// The floor job runs on `pull_request` and reads comment state at its own start, so it always judges
// a head that has no verdict yet and nothing re-fires it. The gate that just wrote the verdict is the
// actor with no ordering problem — founder ruling, 2026-08-16 (#5585).
describe("runPost asserts the governance floor at the head it posted to", () => {
	const landed = (...extra: ReadonlyArray<Scripted>): ReadonlyArray<Scripted> =>
		governing(
			[CREATE, {status: 201, body: created().stdout}],
			[READ_BACK, {status: 200, body: JSON.stringify({body: composed()})}],
			...extra,
		);

	/** The `{total_count, workflow_runs}` envelope at the head the verdict landed on. */
	const floorListed: Scripted = [
		RUNS,
		{status: 200, body: runsAtHead(1, [{id: FLOOR, name: "governance-floor"}]).stdout},
	];

	/** The floor's check-run at the head, still pending — the state a re-fire is owed to (#6161). */
	const floorPending: Scripted = [
		HEAD_CHECK_RUNS,
		{
			status: 200,
			body: checkRuns(1, [{name: CHECK_RUN_NAME, status: "in_progress", conclusion: null}]).stdout,
		},
	];

	const floorRed = (): ReadonlyArray<Scripted> => [
		[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
		[RERUN, accepted],
		[RUN, workflowRun({id: FLOOR, attempt: 2})],
		floorPending,
	];

	it("re-fires the red floor run and names the new attempt on stderr", async () => {
		const {seams, layer} = layerFor([...floorRed(), ...landed(floorListed)]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), layer));
		expect(out.code).toBe(0);
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(true);
		expect(out.stderr.at(-1)).toContain(`re-fired governance-floor run ${FLOOR} at attempt 2`);
	});

	it("carries the floor's outcome in the --json record", async () => {
		const out = await run([...floorRed(), ...landed(floorListed)], {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({outcome: "posted", floor: "refired"});
	});

	// The verdict is landed and read back before the floor is touched, so a floor that could not be
	// asserted is a red check to clear, never an unwritten verdict to retry.
	it("still answers 0 when the floor cannot be asserted, and says the check may need a re-fire", async () => {
		const out = await run(landed([RUNS, {status: 502, body: "{}"}]));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tcreated\t");
		expect(out.stderr.at(-1)).toContain("may still need a re-fire");
	});

	// The order is proven by what a failed read-back leaves undone rather than by two indices in one
	// list: a verdict that did not read back re-fires nothing at all.
	it("asserts the floor only after the verdict has been read back", async () => {
		const {seams, layer} = layerFor([
			...floorRed(),
			...governing(
				[CREATE, {status: 201, body: created().stdout}],
				[READ_BACK, {status: 502, body: "{}"}],
				floorListed,
			),
		]);
		await Effect.runPromise(Effect.provide(runPost(options), layer));
		expect(seams.requests.some((call) => READ_BACK.test(call))).toBe(true);
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});
});
