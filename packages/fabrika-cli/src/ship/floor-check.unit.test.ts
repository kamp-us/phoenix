/**
 * The check-run mode's whole point is that ONE of the blocking states reads as waiting: `absent`
 * means nobody has judged this head yet, and showing that as the same red a FAIL shows is what
 * taught people to stop reading reds (#6161). So the battery below pins the conclusion map row by
 * row, and pins the two things the polarity change must not cost — a `stale`/`fail` verdict still
 * concludes failure, and an UNKNOWN still concludes failure rather than waiting (ADR 0092).
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {checkRuns, comments, ENV, files, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";
import {CHECK_RUN_NAME, floorRunner, planFor, runFloorCheck} from "./floor-check.ts";
import {runFloor} from "./floor-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const FILES = /^GET \S+\/repos\/o\/r\/pulls\/4321\/files\?/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4321\/comments\?/;
const REVIEWS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /^GET \S+\/repos\/o\/r\/collaborators\/[^/]+\/permission$/;
const HEAD_CHECKS = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const CREATE = /^POST \S+\/repos\/o\/r\/check-runs$/;
const UPDATE = /^PATCH \S+\/repos\/o\/r\/check-runs\/\d+$/;

const NO_REVIEWS: Scripted = [REVIEWS, {status: 200, body: "[]"}];
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});
const permissionServed = (permission: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({permission}),
});

/** A fabrika-tree diff — `claude-plugins/` is one of the shipped governance roots. */
const FABRIKA_TREE: Scripted = [
	FILES,
	served(files("claude-plugins/fabrika/skills/ship/SKILL.md", "apps/web/src/b.ts")),
];

/** What GitHub echoes for a check-run this run just wrote. */
const echoed = (status: string, conclusion: string | null, id = 77): HttpReply => ({
	status: 201,
	body: JSON.stringify({id, name: CHECK_RUN_NAME, status, conclusion}),
});

/** The head carrying no check-run of the floor's name — the first run at a fresh head. */
const NO_HELD_CHECK: Scripted = [
	HEAD_CHECKS,
	{
		status: 200,
		body: checkRuns(1, [{name: "ci", status: "completed", conclusion: "success"}]).stdout,
	},
];

const options = {pr: 4321, sha: HEAD, repo: null, json: false, cwd: "/repo", env: ENV};

const seamsFor = (script: ReadonlyArray<Scripted>) => fakeSeams([...script, NO_REVIEWS]);

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = seamsFor(script);
	return Effect.runPromise(
		Effect.provide(
			runFloorCheck({...options, ...overrides}),
			Layer.merge(seams.layer, unconfigured),
		),
	).then((outcome) => ({outcome, seams}));
};

const marker = (namespace: string, polarity: string, sha: string): string =>
	`${namespace}: ${polarity} @ ${sha} — the clause`;

/** A governance-root PR carrying exactly one comment, with the ACL answer the case wants. */
const withVerdict = (body: string, permission = "write"): ReadonlyArray<Scripted> => [
	[PULL, served(pull({comments: 1}))],
	FABRIKA_TREE,
	[COMMENTS, served(comments({id: 1, body}))],
	[ACL, permissionServed(permission)],
];

/** What the one write in a run carried — the claim "it posted PENDING" can be read nowhere else. */
const written = (seams: {
	readonly requests: ReadonlyArray<string>;
	readonly bodies: ReadonlyArray<string>;
}) => {
	const at = seams.requests.findIndex((call) => CREATE.test(call) || UPDATE.test(call));
	return at === -1 ? null : JSON.parse(seams.bodies[at] ?? "{}");
};

describe("planFor is the conclusion map, whole", () => {
	const sha = HEAD;
	const bound = (state: string) => ({_tag: "Bound" as const, state, sha, scanned: 2, stderr: []});

	it("concludes success on the two states that owe nothing", () => {
		expect(planFor(1, {_tag: "Unbound", sha, scanned: 2, stderr: []})).toMatchObject({
			_tag: "Concluded",
			conclusion: "success",
			floor: "n/a",
		});
		expect(planFor(1, bound("pass"))).toMatchObject({_tag: "Concluded", conclusion: "success"});
	});

	it("leaves the check PENDING on absent — the one state that is not yet, rather than wrong", () => {
		expect(planFor(1, bound("absent"))).toMatchObject({_tag: "Pending", floor: "blocked"});
	});

	it("concludes failure on a verdict that is stale or FAIL", () => {
		expect(planFor(1, bound("stale"))).toMatchObject({_tag: "Concluded", conclusion: "failure"});
		expect(planFor(1, bound("fail"))).toMatchObject({_tag: "Concluded", conclusion: "failure"});
	});

	// A state word this map has never seen concludes failure for the same reason the rollup reds an
	// unrecognised conclusion: a permissive default is guaranteed wrong exactly where nobody looked.
	it("concludes failure on a state it has never seen", () => {
		expect(planFor(1, bound("something-new"))).toMatchObject({
			_tag: "Concluded",
			conclusion: "failure",
		});
	});

	it("concludes failure on UNKNOWN rather than waiting (ADR 0092)", () => {
		const plan = planFor(1, {
			_tag: "Unresolved",
			outcome: {code: 11, stdout: "", stderr: ["ship floor: cannot read the changed-file list"]},
		});
		expect(plan).toMatchObject({_tag: "Concluded", conclusion: "failure", floor: "unresolved"});
		expect(plan.summary).toContain("cannot read the changed-file list");
	});
});

describe("runFloorCheck publishes the answer and exits 0 on having published it", () => {
	it("leaves the check pending when no verdict has been posted at this head", async () => {
		const {outcome, seams} = await run([
			[PULL, served(pull({comments: 0}))],
			FABRIKA_TREE,
			[COMMENTS, served(comments())],
			NO_HELD_CHECK,
			[CREATE, echoed("in_progress", null)],
		]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({
			name: CHECK_RUN_NAME,
			head_sha: HEAD,
			status: "in_progress",
		});
		expect(written(seams).conclusion).toBeUndefined();
		expect(outcome.stdout).toContain("floor\tblocked");
	});

	it("concludes success on a head-bound PASS from an authorized author", async () => {
		const {outcome, seams} = await run([
			...withVerdict(marker("governance", "PASS", HEAD)),
			NO_HELD_CHECK,
			[CREATE, echoed("completed", "success")],
		]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({status: "completed", conclusion: "success"});
		expect(outcome.stdout).toContain("floor\tsatisfied");
	});

	it("concludes failure on a verdict bound to another head", async () => {
		const {outcome, seams} = await run([
			...withVerdict(marker("governance", "PASS", OTHER_HEAD)),
			NO_HELD_CHECK,
			[CREATE, echoed("completed", "failure")],
		]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({status: "completed", conclusion: "failure"});
		expect(outcome.stdout).toContain("ns\tgovernance\tstale");
	});

	it("concludes success and says n/a when the diff touches no governance root", async () => {
		const {outcome, seams} = await run([
			[PULL, served(pull())],
			[FILES, served(files("apps/web/src/a.ts", "apps/web/src/b.ts"))],
			NO_HELD_CHECK,
			[CREATE, echoed("completed", "success")],
		]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({conclusion: "success"});
		expect(outcome.stdout).toContain("floor\tn/a");
	});

	// The job relays this exit code, so an UNKNOWN that published its own red must not ALSO red the
	// job: the red belongs on the check-run, and the job's non-zero is reserved for a failed publish.
	it("publishes a red for an UNKNOWN floor and still exits 0", async () => {
		const {outcome, seams} = await run([
			[PULL, served(pull())],
			[FILES, {status: 502, body: "{}"}],
			NO_HELD_CHECK,
			[CREATE, echoed("completed", "failure")],
		]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({conclusion: "failure"});
		expect(outcome.stdout).toContain("floor\tunresolved");
	});

	it("rewrites the check-run this head already carries instead of stacking a second", async () => {
		const {outcome, seams} = await run([
			...withVerdict(marker("governance", "PASS", HEAD)),
			[
				HEAD_CHECKS,
				{
					status: 200,
					body: checkRuns(1, [
						{name: CHECK_RUN_NAME, status: "in_progress", conclusion: null, id: 55},
					]).stdout,
				},
			],
			[UPDATE, echoed("completed", "success", 55)],
		]);
		expect(outcome.code).toBe(0);
		expect(seams.requests.some((call) => UPDATE.test(call))).toBe(true);
		expect(seams.requests.some((call) => CREATE.test(call))).toBe(false);
	});

	// An update cannot clear a conclusion the platform has already recorded, so re-opening a completed
	// check-run as pending would silently leave the PR showing the old conclusion.
	it("posts a fresh check-run rather than re-opening a completed one as pending", async () => {
		const {outcome, seams} = await run([
			[PULL, served(pull({comments: 0}))],
			FABRIKA_TREE,
			[COMMENTS, served(comments())],
			[
				HEAD_CHECKS,
				{
					status: 200,
					body: checkRuns(1, [
						{name: CHECK_RUN_NAME, status: "completed", conclusion: "failure", id: 55},
					]).stdout,
				},
			],
			[CREATE, echoed("in_progress", null)],
		]);
		expect(outcome.code).toBe(0);
		expect(seams.requests.some((call) => CREATE.test(call))).toBe(true);
		expect(seams.requests.some((call) => UPDATE.test(call))).toBe(false);
	});
});

describe("a floor nobody published is the one thing this mode reds the job on", () => {
	it("refuses when the check-run could not be written", async () => {
		const {outcome} = await run([
			...withVerdict(marker("governance", "PASS", HEAD)),
			NO_HELD_CHECK,
			[CREATE, {status: 403, body: '{"message":"Forbidden"}'}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("nothing published it");
	});

	// The echo is the read-back: a check-run the PR shows in a state this run did not decide is not a
	// published answer, and reporting it as one would put a green on a floor nobody discharged.
	it("refuses when GitHub echoes a state this run did not decide", async () => {
		const {outcome} = await run([
			[PULL, served(pull({comments: 0}))],
			FABRIKA_TREE,
			[COMMENTS, served(comments())],
			NO_HELD_CHECK,
			[CREATE, echoed("completed", "success")],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a malformed --sha before writing anything at all", async () => {
		const {outcome, seams} = await run([], {sha: "not-a-sha"});
		expect(outcome.code).not.toBe(0);
		expect(seams.requests.some((call) => CREATE.test(call))).toBe(false);
	});

	// A list nobody could read is not a head carrying no row. Reading the two as one would post a
	// second check-run beside a row that may already be there, breaking one-row-per-head with no
	// signal anywhere — so the read refuses like every other reader of this seam does.
	it("refuses when the check-runs at the head could not be enumerated", async () => {
		const {outcome, seams} = await run([
			...withVerdict(marker("governance", "PASS", HEAD)),
			[HEAD_CHECKS, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("cannot enumerate the check runs");
		expect(seams.requests.some((call) => CREATE.test(call) || UPDATE.test(call))).toBe(false);
	});
});

describe("--publish-check selects the mode", () => {
	it("routes the flag to the check-run mode and its absence to the exit-code one", () => {
		expect(floorRunner(true)).toBe(runFloorCheck);
		expect(floorRunner(false)).toBe(runFloor);
	});
});
