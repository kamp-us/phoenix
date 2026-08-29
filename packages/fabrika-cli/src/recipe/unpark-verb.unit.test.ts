import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeSeams,
	type HttpReply,
	okOut,
	once,
	type Scripted,
} from "../fakes.test-support.ts";
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
	campaignsTable,
	closingPulls,
	httpError,
	LANE,
	LANE_BRANCH,
	LANE_MILESTONE,
	LANES_ROOT,
	LOG,
	laneTemplate,
	nominatedPulls,
	PARKED_AT_CP,
	PARKED_BLOCKED,
	PARKED_ON_CAMPAIGN,
	PARKED_ON_WORKTREE,
	parkedBlockedOn,
	WORKFLOW,
	worktreeList,
} from "./fixtures.test-support.ts";
import {runUnpark} from "./unpark-verb.ts";

const CLOSERS = /^POST .*\/graphql$/;
const SEARCH = /^GET .*\/search\/issues\?/;
const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const SECOND_PULL = /^GET .*\/repos\/o\/r\/pulls\/4322$/;
const FILES = /^GET .*\/repos\/o\/r\/pulls\/4321\/files\?/;
const OWNERS = /contents\/\.github\/CODEOWNERS/;
const COMPARE = /\/repos\/o\/r\/compare\//;
const ROSTER = /orgs\/kamp-us\/teams\/control-plane\/members/;
const REVIEWS = /\/repos\/o\/r\/pulls\/4321\/reviews/;
const BRANCHES = /^git for-each-ref/;
const TREES = /^git worktree list/;
const PRUNE = /^git worktree prune$/;
const REMOVE = /^git worktree remove /;
const STATUS = /^git -C \S+ status --porcelain$/;
const SELF = /^git rev-parse --path-format=absolute/;
const LANE_ISSUE = new RegExp(`^GET \\S+/repos/o/r/issues/${LANE}$`);
const LANE_COMMENTS = new RegExp(`^GET \\S+/repos/o/r/issues/${LANE}/comments`);
const REMOTES = /^git remote$/;
const FETCH = /^git fetch --quiet origin main$/;
const RESOLVE = /^git rev-parse --verify/;
const SHOW = /^git show \S+:ROADMAP\.md$/;

/** The checkout the clearance reads `.fabrika.jsonc` off — unconfigured, so `ROADMAP.md` is default. */
const CWD = "/repo";
const TRUNK_SHA = "0123456789abcdef0123456789abcdef01234567";

/** What `build retire` reads the park's number as — an open issue, so only a closed one licenses. */
const openIssue = {
	number: Number(LANE),
	title: "the lane's issue",
	body: "",
	state: "open",
	labels: [],
	html_url: `https://github.com/o/r/issues/${LANE}`,
	milestone: null,
	state_reason: null,
};

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/** The §CP path set, so the boundary classifies `control-plane` and the discharge table runs. */
const CP_FILES = reply(files(".github/workflows/ci.yml", "README.md"));

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

/** A discharged §CP park's target half: the closing PR, its shape, its changed files. */
const DISCHARGED: ReadonlyArray<Scripted> = [
	[CLOSERS, reply(closingPulls(4321))],
	[PULL, reply(pull({author: "usirin"}))],
	[FILES, CP_FILES],
];

/** The clearance half: the boundary, no base drift, the roster, an approving owner at the live head. */
const DISCHARGED_HTTP: ReadonlyArray<Scripted> = [
	[OWNERS, {status: 200, body: CODEOWNERS}],
	[COMPARE, {status: 200, body: '{"behind_by":0}'}],
	[ROSTER, members("usirin", "notusirin")],
	[REVIEWS, reviewPage({login: "notusirin", state: "APPROVED", commit: HEAD})],
];

const lane = (log: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({files: {[WORKFLOW]: laneTemplate(), [LOG]: log}, ...extra});

/** A second candidate the search index alone nominates, its body linking the same lane issue. */
const otherPull = (number: number): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number,
		state: "open",
		head: {sha: HEAD},
		base: {ref: "main"},
		body: `Part of #${LANE}\n`,
		changed_files: 1,
		comments: 0,
		user: {login: "usirin"},
		html_url: `https://github.com/o/r/pull/${number}`,
	}),
});

const NO_NOMINATIONS: Scripted = [SEARCH, reply(nominatedPulls())];

const run = (
	fs: ReturnType<typeof fakeFs>,
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted> = DISCHARGED_HTTP,
	task: string | null = null,
) =>
	Effect.runPromise(
		Effect.provide(
			runUnpark({root: LANES_ROOT, lane: LANE, task, repo: null, cwd: CWD, env: ENV}),
			// The nominator's body-search half is tailed, so a test scripting its own wins the lookup.
			// Empty by default: the union then answers off the closing edge, as these tests always did.
			Layer.merge(fs.layer, fakeSeams([...script, ...http, NO_NOMINATIONS]).layer),
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

	it("clears a §CP park whose PR only says `Part of #N` — the shared nominator's body half (#6179)", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [
			[CLOSERS, reply(closingPulls())],
			[SEARCH, reply(nominatedPulls(4321))],
			[PULL, reply(pull({author: "usirin", body: `Part of #${LANE}\n`}))],
			[FILES, CP_FILES],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({park: "human:cp-approval", current: "ship"});
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

	it("is PARK_HOLDS while a working tree holds the branch and the board licenses no retirement", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(
			fs,
			[
				[BRANCHES, branchList(LANE_BRANCH)],
				[TREES, worktreeList({path: "/trees/agent-a9bd", branch: LANE_BRANCH})],
				[PRUNE, okOut("")],
				[SELF, okOut(["/repo/.git", "/repo"].join("\n"))],
			],
			[
				[LANE_ISSUE, {status: 200, body: JSON.stringify(openIssue)}],
				[LANE_COMMENTS, {status: 200, body: "[]"}],
			],
		);

		expect(out.code).toBe(PARK_HOLDS);
		expect(out.stderr.join("\n")).toMatch(/\/trees\/agent-a9bd/);
		expect(fs.written.size).toBe(0);
	});

	// The routing half of #6610: the row names `fabrika build retire`, so a park whose only cause is a
	// stale registration clears without a human running `git worktree remove` by hand.
	it("clears the park by retiring the holding tree when the board licenses it", async () => {
		const fs = lane(PARKED_ON_WORKTREE);

		const out = await run(
			fs,
			[
				[BRANCHES, branchList(LANE_BRANCH)],
				[once(TREES), worktreeList({path: "/trees/agent-a9bd", branch: LANE_BRANCH})],
				[PRUNE, okOut("")],
				[once(TREES), worktreeList({path: "/trees/agent-a9bd", branch: LANE_BRANCH})],
				[SELF, okOut(["/repo/.git", "/repo"].join("\n"))],
				[STATUS, okOut("")],
				[REMOVE, okOut("")],
				[TREES, worktreeList()],
			],
			[
				[LANE_ISSUE, {status: 200, body: JSON.stringify({...openIssue, state: "closed"})}],
				[LANE_COMMENTS, {status: 200, body: "[]"}],
			],
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).mechanism).toMatch(/retired 1 working tree/);
		expect(fs.written.get(LOG)).toMatch(/ISSUE\.UNBLOCKED/);
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

describe("recipe unpark — a campaign-paused park clears on the row it parked on (#7217)", () => {
	/** The lane's issue as the clearance reads it: homed on the milestone a campaign row pins. */
	const homed = (milestone: number | null): ReadonlyArray<Scripted> => [
		[
			LANE_ISSUE,
			{
				status: 200,
				body: JSON.stringify({
					...openIssue,
					milestone: milestone === null ? null : {number: milestone},
				}),
			},
		],
	];

	/** The trunk read: fetch the base, resolve it, show `ROADMAP.md` as of that commit. */
	const trunkRoadmap = (text: string): ReadonlyArray<Scripted> => [
		[REMOTES, okOut("origin")],
		[FETCH, okOut("")],
		[RESOLVE, okOut(TRUNK_SHA)],
		[SHOW, okOut(text)],
	];

	const campaign = (state: string): ReadonlyArray<Scripted> =>
		trunkRoadmap(campaignsTable({name: "Epic lanes", milestone: LANE_MILESTONE, state}));

	it("clears once the lane's campaign reads active again", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(fs, campaign("active"), homed(LANE_MILESTONE));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			park: "blocked",
			clearance: "campaign-active",
			mechanism: `campaign-active:#${LANE_MILESTONE}`,
			current: "build",
		});
		expect(fs.written.get(LOG)).toMatch(/ISSUE\.UNBLOCKED/);
	});

	it("is PARK_HOLDS while the row still reads paused, naming the state it read", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(fs, campaign("paused"), homed(LANE_MILESTONE));

		expect(out.code).toBe(PARK_HOLDS);
		expect(out.stderr.join("\n")).toMatch(/reads paused/);
		expect(fs.written.size).toBe(0);
	});

	// `done` is not `active` either, and the recipe may not read a retired campaign as a resumed one.
	it("is PARK_HOLDS on a done campaign — only active clears", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(fs, campaign("done"), homed(LANE_MILESTONE));

		expect(out.code).toBe(PARK_HOLDS);
		expect(out.stderr.join("\n")).toMatch(/reads done/);
		expect(fs.written.size).toBe(0);
	});

	it("is UNKNOWN when ROADMAP.md cannot be read at the trunk — never a cleared park", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(
			fs,
			[
				[REMOTES, okOut("origin")],
				[FETCH, okOut("")],
				[RESOLVE, okOut(TRUNK_SHA)],
				[SHOW, errOut("fatal: path 'ROADMAP.md' does not exist")],
			],
			homed(LANE_MILESTONE),
		);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/cannot read ROADMAP\.md at origin\/main/);
		expect(fs.written.size).toBe(0);
	});

	it("is UNKNOWN when the ## Campaigns table will not parse — never a cleared park", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(
			fs,
			trunkRoadmap(
				["## Campaigns", "", "| Campaign | Milestone | State |", "|---|---|---|", "| Epic lanes |"]
					.join("\n")
					.concat("\n"),
			),
			homed(LANE_MILESTONE),
		);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/cannot read the ## Campaigns table/);
		expect(fs.written.size).toBe(0);
	});

	it("is TARGET_ABSENT when the lane's issue is homed on no milestone", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(fs, campaign("active"), homed(null));

		expect(out.code).toBe(TARGET_ABSENT);
		expect(out.stderr.join("\n")).toMatch(/homed on no milestone/);
		expect(fs.written.size).toBe(0);
	});

	it("is TARGET_ABSENT when no campaign row pins the lane's milestone", async () => {
		const fs = lane(PARKED_ON_CAMPAIGN);

		const out = await run(
			fs,
			trunkRoadmap(campaignsTable({name: "Some other campaign", milestone: 51, state: "active"})),
			homed(LANE_MILESTONE),
		);

		expect(out.code).toBe(TARGET_ABSENT);
		expect(out.stderr.join("\n")).toMatch(new RegExp(`pins milestone #${LANE_MILESTONE}`));
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
				[CLOSERS, reply(closingPulls(4321))],
				[PULL, reply(pull())],
				[FILES, reply(files("apps/web/src/App.tsx", "README.md"))],
			],
			[
				[OWNERS, {status: 200, body: CODEOWNERS}],
				[COMPARE, {status: 200, body: '{"behind_by":0}'}],
			],
		);

		expect(out.code).toBe(PARK_NOVEL);
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_NOVEL when several open PRs link the issue", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [
			[CLOSERS, reply(closingPulls(4321))],
			[SEARCH, reply(nominatedPulls(4322))],
			[PULL, reply(pull({author: "usirin"}))],
			[SECOND_PULL, otherPull(4322)],
		]);

		expect(out.code).toBe(PARK_NOVEL);
		expect(out.stderr.join("\n")).toMatch(/#4321, #4322/);
		expect(fs.written.size).toBe(0);
	});

	it("is PARK_HOLDS while the approval is still outstanding — a distinct code from novel", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(
			fs,
			[
				[CLOSERS, reply(closingPulls(4321))],
				[PULL, reply(pull({author: "usirin"}))],
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

	it("is TARGET_ABSENT when no open PR links the issue the park hangs on", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [[CLOSERS, reply(closingPulls())]]);

		expect(out.code).toBe(TARGET_ABSENT);
		expect(fs.written.size).toBe(0);
	});

	it("is UNKNOWN when the closing-PR read fails — never a cleared park", async () => {
		const fs = lane(PARKED_AT_CP);

		const out = await run(fs, [[CLOSERS, httpError(503, "api down")]]);

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
				runUnpark({root, lane: "nightly", task: null, repo: null, cwd: CWD, env: ENV}),
				Layer.merge(fs.layer, fakeSeams([...DISCHARGED, ...DISCHARGED_HTTP]).layer),
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
