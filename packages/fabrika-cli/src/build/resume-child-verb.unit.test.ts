/**
 * The mechanized epic-child repair entry, EXECUTED.
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
import {FAILED} from "../verb.ts";
import {
	CLAIM_NOT_MINE,
	DIRTY_TREE,
	PRECONDITION_UNKNOWN,
	PRIOR_BUILD_MISMATCH,
	TYPE_NOT_BUILDABLE,
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
const POSTED = served({id: 9001, html_url: "https://example.test/o/r/issues/4312#c"}, 201);
const ECHO = served({body: MINE});

const labelled = (...names: ReadonlyArray<string>) => names.map((name) => ({name}));
const CLAIMABLE = issue({labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent")});
/** The shape that found this: a decision triage stamped for an agent once a founder had ruled on it. */
const RULED_DECISION = issue({
	labels: labelled("type:decision", "p1", "status:triaged", "ready-for:agent"),
});
const RULING = `https://github.com/o/r/issues/${CHILD}#issuecomment-5335398768`;

const RANGE = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4..03135b917283a4b5c6d7e8f90a1b2c3d4e5f6071";
const rangeVerdict = (polarity: string) =>
	`review-code: ${polarity} range:${RANGE} content:2f1a9c4e0b7d — the child's range`;

const graded = (polarity: string) => comments({id: 8801, body: rangeVerdict(polarity)});
/** The thread once this lane's marker has landed beside the verdict it is repairing. */
const CLAIMED_THREAD = comments(
	{id: 8801, body: rangeVerdict("FAIL")},
	{id: 9001, body: MINE, createdAt: "2026-08-09T00:00:01Z"},
);

/** The board a mid-sequence stop leaves behind: this lane's marker already standing beside the FAIL. */
const HOLDS_THE_CLAIM: ReadonlyArray<Scripted> = [
	[COMMENTS, CLAIMED_THREAD],
	[ISSUE, CLAIMABLE],
	[PERM, WRITES],
	NO_BLOCKERS,
];

/** The same standing marker, over the decision child — the continuation asks for no ruling again. */
const HOLDS_THE_DECISION_CLAIM: ReadonlyArray<Scripted> = [
	[COMMENTS, CLAIMED_THREAD],
	[ISSUE, RULED_DECISION],
	[PERM, WRITES],
	NO_BLOCKERS,
];

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

/** The same race, over a ruled decision child: only the type the issue carries differs. */
const WINS_AS_DECISION: ReadonlyArray<Scripted> = [
	[once(COMMENTS), graded("FAIL")],
	[POST, POSTED],
	[GET_COMMENT, ECHO],
	[COMMENTS, CLAIMED_THREAD],
	[ISSUE, RULED_DECISION],
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
	cites: null as string | null,
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
	 * The inversion this pins: the armed proof ran first, refused the generic branch on `14`, and the
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

	it("names the exact --token re-run that continues the lane, not a bare one", async () => {
		const {outcome} = await run([
			...WINS_THE_CLAIM,
			[TREE_ROOT, GIT_DIRS],
			[STATUS, okOut(" M a.ts\n")],
		]);
		expect(outcome.stderr.join("\n")).toContain(
			`"fabrika build resume-child ${CHILD} --token ${LANE_TOKEN}"`,
		);
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

/**
 * The continuation the stop line promises, executed. A mid-sequence stop leaves a marker on the
 * board, and only the `--token` arm of `build claim` answers off it — so this is the run that has to
 * work, and the one the surfaces have to name. They said "re-run this verb" and meant this.
 */
describe("runResumeChild — continuing a lane that already holds its claim", () => {
	it("carries the same claim through on --token, writing no second marker", async () => {
		const {outcome, shell} = await run([...HOLDS_THE_CLAIM, ...GENERIC_CHECKOUT], {
			token: LANE_TOKEN,
		});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "resumed",
			issue: CHILD,
			token: LANE_TOKEN,
			branch: RESUMED,
			root: "/repo/trees/lane-a",
			claim: {number: CHILD, nonce: NONCE},
		});
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(outcome.stderr.join("\n")).toContain("already held by this lane");
	});

	it("reaches the checkout the stop short-circuited, in the same order", async () => {
		const {shell} = await run([...HOLDS_THE_CLAIM, ...GENERIC_CHECKOUT], {token: LANE_TOKEN});
		expect(shell.calls).toContain(`git branch -m ${PRIOR} ${RESUMED}`);
		expect(shell.calls.findIndex((line) => STATUS.test(line))).toBeLessThan(
			shell.calls.findIndex((line) => RENAME.test(line)),
		);
		expect(shell.calls.findIndex((line) => SWITCH.test(line))).toBeLessThan(
			shell.calls.findIndex((line) => ABBREV_REF.test(line)),
		);
	});
});

/**
 * The citation passthrough, executed.
 *
 * A `type:decision` child is the common first child of an epic — a ruling gets recorded before the
 * work it governs is built — so the first repair round of the common shape hit a `30` the entry had
 * no flag to answer, and the only route left was hand-assembling the five steps this verb exists to
 * take out of a builder's hands. What the coverage has to prove is that the value reaches the claim
 * step and stops there: the arm opens, and nothing else about the fence moves.
 */
describe("runResumeChild — the ruled decision child's repair", () => {
	it("opens the lane on a cited ruling, running the same sequence to the armed proof", async () => {
		const {outcome, shell} = await run([...WINS_AS_DECISION, ...GENERIC_CHECKOUT], {
			cites: RULING,
		});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "resumed",
			issue: CHILD,
			token: LANE_TOKEN,
			branch: RESUMED,
			root: "/repo/trees/lane-a",
			claim: {number: CHILD, nonce: NONCE},
		});
		expect(outcome.stderr.join("\n")).toContain(
			`admitted as transcription of the founder ruling at ${RULING}`,
		);
		expect(shell.calls).toContain(`git branch -m ${PRIOR} ${RESUMED}`);
		expect(shell.calls).toContain(`git switch ${RESUMED}`);
	});

	it("still refuses an uncited decision on 30, before any marker or git step", async () => {
		const {outcome, shell} = await run([...WINS_AS_DECISION, ...GENERIC_CHECKOUT]);
		expect(outcome.code).toBe(TYPE_NOT_BUILDABLE);
		expect(outcome.stderr.join("\n")).toContain("type not buildable");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(shell.calls).toEqual([]);
	});

	it.each([
		["malformed", "issues/4312#issuecomment-5335398768"],
		["another repository's", "https://github.com/other/repo/issues/4312#issuecomment-5335398768"],
		["another issue's", "https://github.com/o/r/issues/9999#issuecomment-5335398768"],
	])("keeps build claim's own refusal for %s citation, moving no branch", async (_kind, cites) => {
		const {outcome, shell} = await run([...WINS_AS_DECISION, ...GENERIC_CHECKOUT], {cites});
		expect(outcome.code).toBe(FAILED);
		expect(outcome.stderr.at(-1)).toContain("build claim: --cites");
		expect(outcome.stderr.at(-1)).toContain("nothing was written");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(shell.calls).toEqual([]);
	});

	it("leaves an ordinary bug child's repair unchanged, cited or not", async () => {
		const bare = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT]);
		const cited = await run([...WINS_THE_CLAIM, ...GENERIC_CHECKOUT], {cites: RULING});
		expect(bare.outcome.code).toBe(0);
		expect(cited.outcome.code).toBe(0);
		expect(cited.outcome.stdout).toBe(bare.outcome.stdout);
	});

	it("admits no type a citation was never an arm for — an epic child is still 30", async () => {
		const {outcome, shell} = await run(
			[
				[once(COMMENTS), graded("FAIL")],
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, CLAIMED_THREAD],
				[ISSUE, issue({labels: labelled("type:epic", "p1", "status:triaged", "ready-for:agent")})],
				[PERM, WRITES],
				NO_BLOCKERS,
				...GENERIC_CHECKOUT,
			],
			{cites: RULING},
		);
		expect(outcome.code).toBe(TYPE_NOT_BUILDABLE);
		expect(shell.calls).toEqual([]);
	});

	it("continues the decision lane on --token alone, with no citation and no second marker", async () => {
		const {outcome, shell} = await run([...HOLDS_THE_DECISION_CLAIM, ...GENERIC_CHECKOUT], {
			token: LANE_TOKEN,
		});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).branch).toBe(RESUMED);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(outcome.stderr.join("\n")).toContain("already held by this lane");
	});
});
