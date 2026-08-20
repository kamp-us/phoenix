import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {CODEOWNERS, ENV, files, HEAD, pull} from "../ship/fixtures.test-support.ts";
import {
	NOT_PARKED,
	PARK_HOLDS,
	PARK_NOVEL,
	PRECONDITION_UNKNOWN,
	TARGET_ABSENT,
	TASK_UNRESOLVED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	branchList,
	closingPulls,
	LANE,
	LANE_BRANCH,
	LANES_ROOT,
	LOG,
	laneTemplate,
	PARKED_AT_CP,
	PARKED_BLOCKED,
	PARKED_ON_WORKTREE,
	parkedBlockedOn,
	WORKFLOW,
	worktreeList,
} from "./fixtures.test-support.ts";
import {runUnpark} from "./unpark-verb.ts";

const CLOSERS = /^gh api graphql/;
const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const OWNERS = /contents\/\.github\/CODEOWNERS/;
const COMPARE = /\/repos\/o\/r\/compare\//;
const ROSTER = /orgs\/kamp-us\/teams\/control-plane\/members/;
const REVIEWS = /\/repos\/o\/r\/pulls\/4321\/reviews/;
const BRANCHES = /^git for-each-ref/;
const TREES = /^git worktree list/;

/** The §CP path set, so the boundary classifies `control-plane` and the discharge table runs. */
const CP_FILES = files(".github/workflows/ci.yml", "README.md");

const members = (...logins: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(logins.map((login) => ({login}))),
});

/** A terminal review page — no `Link: … rel="next"`, so the read proves itself exhausted. */
const reviewPage = (
	...rows: ReadonlyArray<{login: string; state: string; commit: string}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			user: {login: row.login},
			state: row.state,
			commit_id: row.commit,
			submitted_at: "2026-08-08T00:00:00Z",
		})),
	),
});

/** The shell half of a discharged §CP park: the closing PR, its shape, its changed files. */
const DISCHARGED: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[CLOSERS, closingPulls(4321)],
	[PULL, pull({author: "usirin"})],
	[FILES, CP_FILES],
];

/** The HTTP half: the boundary, no base drift, the roster, an approving owner at the live head. */
const DISCHARGED_HTTP: ReadonlyArray<readonly [RegExp, HttpReply]> = [
	[OWNERS, {status: 200, body: CODEOWNERS}],
	[COMPARE, {status: 200, body: '{"behind_by":0}'}],
	[ROSTER, members("usirin", "notusirin")],
	[REVIEWS, reviewPage({login: "notusirin", state: "APPROVED", commit: HEAD})],
];

const lane = (log: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({files: {[WORKFLOW]: laneTemplate(), [LOG]: log}, ...extra});

const run = (
	fs: ReturnType<typeof fakeFs>,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = DISCHARGED_HTTP,
	task: string | null = null,
) =>
	Effect.runPromise(
		Effect.provide(
			runUnpark({root: LANES_ROOT, lane: LANE, task, repo: null, env: ENV}),
			Layer.mergeAll(fs.layer, fakeShell(script).layer, fakeHttp(http).layer),
		),
	);

describe("recipe unpark — the known recipe clears", () => {
	it("records UNBLOCKED and answers only after the re-fold reads the task out of the park", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, DISCHARGED);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			lane: LANE,
			task: "issue",
			park: "human:cp-approval",
			clearance: "cp-approval",
			current: "ship",
		});
		expect(fs.written.get(LOG)).toMatch(/ISSUE\.UNBLOCKED/);
	});

	it("names the discharge mechanism it relayed rather than restating the §CP rule", async () => {
		const out = await run(lane(PARKED_AT_CP), DISCHARGED);

		expect(JSON.parse(out.stdout).mechanism).toMatch(/member-approval:notusirin/);
	});
});

describe("recipe unpark — a BLOCKED park clears on its cause (#6480)", () => {
	it("clears the worktree-holds-branch park once no working tree holds the branch", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(fs, [
			[BRANCHES, branchList(LANE_BRANCH, "main")],
			[TREES, worktreeList({path: "/repo", branch: "main"})],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			park: "blocked",
			clearance: "branch-free",
			mechanism: `branch-free:${LANE_BRANCH}`,
			current: "build",
		});
		expect(fs.written.get(LOG)).toMatch(/ISSUE\.UNBLOCKED/);
	});

	it("is PARK_HOLDS while a working tree still holds the branch, naming that tree", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(fs, [
			[BRANCHES, branchList(LANE_BRANCH)],
			[TREES, worktreeList({path: "/trees/agent-a9bd", branch: LANE_BRANCH})],
		]);

		expect(out.code).toBe(PARK_HOLDS);
		expect(out.stderr.join("\n")).toMatch(/\/trees\/agent-a9bd/);
		expect(fs.written.size).toBe(0);
	});

	it("is TARGET_ABSENT in a clone that never cut the branch — never a clear on an absent read", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(fs, [
			[BRANCHES, branchList("main")],
			[TREES, worktreeList({path: "/repo", branch: "main"})],
		]);

		expect(out.code).toBe(TARGET_ABSENT);
		expect(fs.written.size).toBe(0);
	});

	it("is UNKNOWN when the working-tree read fails — never a cleared park", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(fs, [
			[BRANCHES, branchList(LANE_BRANCH)],
			[TREES, errOut("not a git repository")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_NOVEL on a cause no row covers, and names the cause it could not key on", async () => {
		const fs = lane(parkedBlockedOn("some-cause-nobody-wrote-a-row-for"));

		const out = await run(fs, [[BRANCHES, branchList(LANE_BRANCH)]]);

		expect(out.code).toBe(PARK_NOVEL);
		expect(out.stderr.join("\n")).toMatch(/some-cause-nobody-wrote-a-row-for/);
		expect(fs.written.size).toBe(0);
	});
});

describe("recipe unpark — the refusals write nothing", () => {
	it("is PARK_NOVEL on a bare BLOCKED park, with the log byte-identical", async () => {
		const fs = lane(PARKED_BLOCKED);

		const out = await run(fs, DISCHARGED);

		expect(out.code).toBe(PARK_NOVEL);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_NOVEL on a §CP park over a PR the boundary calls ordinary — the mislabeled park", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(
			fs,
			[
				[CLOSERS, closingPulls(4321)],
				[PULL, pull()],
				[FILES, files("apps/web/src/App.tsx", "README.md")],
			],
			[
				[OWNERS, {status: 200, body: CODEOWNERS}],
				[COMPARE, {status: 200, body: '{"behind_by":0}'}],
			],
		);

		expect(out.code).toBe(PARK_NOVEL);
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_NOVEL when several open PRs declare they close the issue", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [[CLOSERS, closingPulls(4321, 4322)]]);

		expect(out.code).toBe(PARK_NOVEL);
		expect(out.stderr.join("\n")).toMatch(/#4321, #4322/);
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_HOLDS while the approval is still outstanding — a distinct code from novel", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(
			fs,
			[
				[CLOSERS, closingPulls(4321)],
				[PULL, pull({author: "usirin"})],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, {status: 200, body: CODEOWNERS}],
				[COMPARE, {status: 200, body: '{"behind_by":0}'}],
				[ROSTER, members("usirin", "notusirin")],
				[REVIEWS, reviewPage()],
			],
		);

		expect(out.code).toBe(PARK_HOLDS);
		expect(out.code).not.toBe(PARK_NOVEL);
		expect(fs.written.size).toBe(0);
	});

	it("is NOT_PARKED on a working state", async () => {
		const fs = lane("");

		const out = await run(fs, DISCHARGED);

		expect(out.code).toBe(NOT_PARKED);
		expect(fs.written.size).toBe(0);
	});

	it("is TARGET_ABSENT when no open PR declares it closes the issue the park hangs on", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [[CLOSERS, closingPulls()]]);

		expect(out.code).toBe(TARGET_ABSENT);
		expect(fs.written.size).toBe(0);
	});

	it("is UNKNOWN when the closing-PR read fails — never a cleared park", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [[CLOSERS, errOut("api down")]]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(fs.written.size).toBe(0);
	});

	it("relays a lane refusal onto this group's seat, not the lane's own number", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, DISCHARGED);

		expect(out.code).toBe(TARGET_ABSENT);
		expect(fs.written.size).toBe(0);
	});

	it("is TASK_UNRESOLVED when the lane names no issue and the task does not either", async () => {
		const root = ".fabrika/lanes";
		const fs = fakeFs({
			files: {
				[`${root}/nightly/workflow.json`]: laneTemplate(),
				[`${root}/nightly/events.jsonl`]: PARKED_AT_CP,
			},
		});

		const out = await Effect.runPromise(
			Effect.provide(
				runUnpark({root, lane: "nightly", task: null, repo: null, env: ENV}),
				Layer.mergeAll(fs.layer, fakeShell(DISCHARGED).layer, fakeHttp(DISCHARGED_HTTP).layer),
			),
		);

		expect(out.code).toBe(TASK_UNRESOLVED);
		expect(fs.written.size).toBe(0);
	});
});

describe("recipe unpark — the read-back is the proof", () => {
	it("is WRITE_UNKNOWN when the append itself does not land — never reported as cleared", async () => {
		const fs = lane(PARKED_AT_CP, {unwritable: [LOG]});

		const out = await run(fs, DISCHARGED);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
