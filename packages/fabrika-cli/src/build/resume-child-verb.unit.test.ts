/**
 * The mechanized epic-child repair entry, EXECUTED (#7187).
 *
 * The prose order this replaces already had a test, and that test parsed the order out of `SKILL.md`
 * — so it passed while a resumed builder read the corrected skill, ran the armed proof first anyway,
 * refused its own generic checkout on `14` and parked the epic. What the coverage has to prove is
 * that the sequence RUNS: a generic checkout plus one prior child branch in, the re-keyed branch
 * checked out and proven on the way out, and every fail-closed stop still distinct.
 */
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
import {
	CLAIM_NOT_MINE,
	DIRTY_TREE,
	PRECONDITION_UNKNOWN,
	PRIOR_BUILD_MISMATCH,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GH_TOKEN_ENV,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NO_BLOCKERS,
	NONCE,
	served,
} from "./fixtures.test-support.ts";
import {runResumeChild} from "./resume-child-verb.ts";

const CHILD = 4312;
const PRIOR = `build/${CHILD}-path-surface-config-c4367b0b`;
const RESUMED = `build/${CHILD}-path-surface-config-${NONCE}`;
/** The isolated checkout a spawned lane lands in — a lane branch to nobody, which is the whole hazard. */
const GENERIC = "worktree-agent-a350db71";

const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const POST = /^POST \S+\/repos\/o\/r\/issues\/4312\/comments/;
const GET_COMMENT = /^GET \S+\/repos\/o\/r\/issues\/comments\/9001$/;
const DELETE = /^DELETE \S+\/repos\/o\/r\/issues\/comments\//;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/\S+\/permission/;

const TREE_ROOT = /^git rev-parse --path-format=absolute/;
const STATUS = /^git status --porcelain$/;
const FOR_EACH_REF = /^git for-each-ref /;
const WORKTREES = /^git worktree list --porcelain$/;
const SHOW_CURRENT = /^git branch --show-current$/;
const RENAME = /^git branch -m /;
const SWITCH = /^git switch build\//;
const ABBREV_REF = /^git rev-parse --abbrev-ref HEAD$/;

const WRITES = served({permission: "write"});
const NO_CONTENT: HttpReply = {status: 204, body: ""};
const MINE = marker("s-9f2e", LANE_UUID);
const THEIRS = marker("s-77aa", "9d8c7b6a-5f4e-3d2c-1b0a-998877665544");
const POSTED = served({id: 9001, html_url: "https://github.com/o/r/issues/4312#c"}, 201);
const ECHO = served({body: MINE});

const labelled = (...names: ReadonlyArray<string>) => names.map((name) => ({name}));
const CLAIMABLE = issue({labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent")});

const RANGE = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4..03135b917283a4b5c6d7e8f90a1b2c3d4e5f6071";
const rangeVerdict = (polarity: string) =>
	`review-code: ${polarity} range:${RANGE} content:2f1a9c4e0b7d — the child's range`;

const graded = (polarity: string) => comments({id: 8801, body: rangeVerdict(polarity)});
/** The thread once this lane's marker has landed beside the verdict it is repairing. */
const CLAIMED_THREAD = comments(
	{id: 8801, body: rangeVerdict("FAIL")},
	{id: 9001, body: MINE, createdAt: "2026-08-09T00:00:01Z"},
);

/** No `ROADMAP.md`: the scope fence is inert, so this suite asks only about the sequence. */
const NO_CAMPAIGNS = fakeFs({files: {}});

/** The race, won: the pre-post verdict read, the marker write, and the checkpoint that resolves it. */
const WINS_THE_CLAIM: ReadonlyArray<Scripted> = [
	[once(COMMENTS), graded("FAIL")],
	[POST, POSTED],
	[GET_COMMENT, ECHO],
	[COMMENTS, CLAIMED_THREAD],
	[ISSUE, CLAIMABLE],
	[PERM, WRITES],
	NO_BLOCKERS,
];

/** Only this tree, standing on the generic isolated branch — the prior lane's branch is free. */
const FREE = okOut(`worktree /repo\nHEAD ${HEAD}\nbranch refs/heads/${GENERIC}\n`);
/** A second worktree still on the prior lane's branch — the one stop only an operator can clear. */
const HELD = okOut(
	`worktree /repo\nHEAD ${HEAD}\nbranch refs/heads/${GENERIC}\n\nworktree /repo/lane-a\nHEAD ${HEAD}\nbranch refs/heads/${PRIOR}\n`,
);

/** The generic checkout the entry opens in: clean, on no lane branch, one prior child branch in refs. */
const GENERIC_CHECKOUT: ReadonlyArray<Scripted> = [
	[TREE_ROOT, GIT_DIRS],
	[STATUS, okOut("")],
	[FOR_EACH_REF, okOut(`main\n${PRIOR}\n${GENERIC}\n`)],
	[WORKTREES, FREE],
	[SHOW_CURRENT, okOut(`${GENERIC}\n`)],
	[RENAME, okOut("")],
	[SWITCH, okOut("")],
	// The armed proof asks after the switch, so this is the branch the entry left the tree on.
	[ABBREV_REF, okOut(`${RESUMED}\n`)],
];

const options = {
	issue: CHILD,
	token: null as string | null,
	repo: null,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	uuid: LANE_UUID,
	at: "2026-08-09T00:00:00Z",
};

const seams = (script: ReadonlyArray<Scripted>) => fakeSeams(script);

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const shell = seams(script);
	return Effect.runPromise(
		Effect.provide(
			runResumeChild({...options, ...overrides}),
			Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
		),
	).then((outcome) => ({outcome, shell}));
};

describe("runResumeChild — the sequenced repair entry", () => {
	it("re-keys the prior child branch, checks it out, and proves the armed lane identity", async () => {
		const {outcome, shell} = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "resumed",
			issue: CHILD,
			token: LANE_TOKEN,
			branch: RESUMED,
			root: "/repo/trees/lane-a",
			claim: {number: CHILD, nonce: NONCE},
		});
		expect(shell.calls).toContain(`git branch -m ${PRIOR} ${RESUMED}`);
		expect(shell.calls).toContain(`git switch ${RESUMED}`);
	});

	/**
	 * The inversion #7187 is: the armed proof ran first, refused the generic branch on `14`, and the
	 * checkout that would have satisfied it never happened. Pinning the two indices is what makes that
	 * order a property of the run rather than of a paragraph.
	 */
	it("checks the branch out BEFORE it arms the lane proof", async () => {
		const {shell} = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT]);
		expect(shell.calls.findIndex((line) => SWITCH.test(line))).toBeLessThan(
			shell.calls.findIndex((line) => ABBREV_REF.test(line)),
		);
	});

	it("proves the generic checkout clean BEFORE it re-keys anything", async () => {
		const {shell} = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT]);
		expect(shell.calls.findIndex((line) => STATUS.test(line))).toBeLessThan(
			shell.calls.findIndex((line) => RENAME.test(line)),
		);
	});

	it("names the branch the checked-out one, on the live claim's nonce", async () => {
		const {outcome} = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT]);
		const answered = JSON.parse(outcome.stdout) as {
			readonly branch: string;
			readonly claim: {readonly nonce: string};
			readonly token: string;
		};
		expect(answered.branch.endsWith(`-${answered.claim.nonce}`)).toBe(true);
		expect(answered.token.endsWith(LANE_UUID)).toBe(true);
		expect(answered.claim.nonce).toBe(LANE_UUID.slice(0, 8));
	});

	/**
	 * The armed step is `runTree`'s own, so a checkout that never moved off the harness branch is
	 * `14` here exactly as it was when a builder typed it — the entry cannot report a lane it is not
	 * standing in.
	 */
	it("cannot report success while the tree is still on a generic harness branch", async () => {
		const {outcome} = await run([
			...WINS_THE_CLAIM,
			...GENERIC_CHECKOUT.filter(([pattern]) => pattern !== ABBREV_REF),
			[ABBREV_REF, okOut(`${GENERIC}\n`)],
		]);
		expect(outcome.code).toBe(WRONG_LANE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain(`"${GENERIC}" is not a lane branch — wrong lane`);
	});
});

describe("runResumeChild — the fail-closed stops, each still its own", () => {
	it("refuses a child holding no standing FAIL on 31, re-keying nothing", async () => {
		const {outcome, shell} = await run([
			[COMMENTS, graded("PASS")],
			[ISSUE, CLAIMABLE],
			[PERM, WRITES],
			NO_BLOCKERS,
			...GENERIC_CHECKOUT,
		]);
		expect(outcome.code).toBe(PRIOR_BUILD_MISMATCH);
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
		expect(shell.calls.some((line) => SWITCH.test(line))).toBe(false);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses a lost claim on 15 before touching git at all", async () => {
		const {outcome, shell} = await run([
			[once(COMMENTS), graded("FAIL")],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				comments(
					{id: 8801, body: rangeVerdict("FAIL")},
					{id: 8900, body: THEIRS, author: "other", createdAt: "2026-08-08T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-09T00:00:01Z"},
				),
			],
			[DELETE, NO_CONTENT],
			[ISSUE, CLAIMABLE],
			[PERM, WRITES],
			NO_BLOCKERS,
			...GENERIC_CHECKOUT,
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a dirty generic checkout on 13, re-keying nothing and naming how to release the claim", async () => {
		const {outcome, shell} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut(" M packages/fabrika-cli/src/build/command.ts\n")],
			...GENERIC_CHECKOUT,
		]);
		expect(outcome.code).toBe(DIRTY_TREE);
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
		expect(outcome.stderr.join("\n")).toContain(
			`"fabrika build release ${CHILD} --token ${LANE_TOKEN}"`,
		);
	});

	it("refuses on 7 when no prior branch was cut for the child", async () => {
		const {outcome, shell} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut("")],
			[FOR_EACH_REF, okOut(`main\n${GENERIC}\n`)],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toContain("no branch anywhere in this clone's refs");
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("refuses on 11 when several prior branches name the child", async () => {
		const {outcome, shell} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut("")],
			[FOR_EACH_REF, okOut(`${PRIOR}\nbuild/${CHILD}-other-shape-11223344\n`)],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("not derivable here");
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("refuses on 11 when another worktree still holds the branch, BEFORE the rename", async () => {
		const {outcome, shell} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut("")],
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			[WORKTREES, HELD],
			[SHOW_CURRENT, okOut(`${GENERIC}\n`)],
			[RENAME, okOut("")],
			[SWITCH, okOut("")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("is checked out in the worktree /repo/lane-a");
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("refuses on 11 when the tree root cannot be read — nothing is proven and nothing moves", async () => {
		const {outcome, shell} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, errOut("fatal: not a git repository")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("names the step it stopped at, and keeps the stopping verb's own reason last", async () => {
		const {outcome} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut(" M a.ts\n")],
		]);
		expect(outcome.stderr.join("\n")).toContain(
			"build resume-child: stopped at the clean-tree step on exit 13",
		);
		expect(outcome.stderr.at(-1)).toContain("uncommitted change(s) at open — refusing");
	});
});
