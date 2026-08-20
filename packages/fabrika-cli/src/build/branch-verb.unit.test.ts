import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {runBranch} from "./branch-verb.ts";
import {CLAIM_NOT_MINE, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	comments,
	GH_TOKEN_ENV,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NONCE,
	pullPayload,
	served,
} from "./fixtures.test-support.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;
const REMOTES = /^git remote$/;
const FETCH = /^git fetch --quiet origin main$/;
const RESOLVE = /^git rev-parse --verify --quiet FETCH_HEAD/;
const VERIFY_BRANCH = /^git rev-parse --verify --quiet refs\/heads\//;
const SWITCH_NEW = /^git switch -c /;

const MINE = comments({id: 1, body: marker("s-9f2e", LANE_UUID)});

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const options = {
	number: 4312 as number | null,
	slug: "editor-focus-loss" as string | null,
	base: "origin/main",
	resume: null as number | null,
	resumeLane: false,
	token: LANE_TOKEN,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
};

const CLAIMED: ReadonlyArray<Scripted> = [
	[REV_PARSE, GIT_DIRS],
	[ISSUE, issue()],
	[COMMENTS, MINE],
	[PERM, WRITE],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runBranch({...options, ...overrides}), fakeSeams(script).layer));

describe("runBranch — create mode", () => {
	it("cuts the lane branch off FETCH_HEAD and prints its name", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[REMOTES, okOut("origin\n")],
			[FETCH, okOut("")],
			[RESOLVE, okOut(`${HEAD}\n`)],
			[VERIFY_BRANCH, errOut("")],
			[SWITCH_NEW, okOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runBranch(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`build/4312-editor-focus-loss-${NONCE}\n`);
		expect(shell.calls).toContain(`git switch -c build/4312-editor-focus-loss-${NONCE} ${HEAD}`);
	});

	it("fetches BEFORE it cuts — never off a stale local ref (#1920)", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[REMOTES, okOut("origin\n")],
			[FETCH, okOut("")],
			[RESOLVE, okOut(`${HEAD}\n`)],
			[VERIFY_BRANCH, errOut("")],
			[SWITCH_NEW, okOut("")],
		]);
		await Effect.runPromise(Effect.provide(runBranch(options), shell.layer));
		expect(shell.calls.findIndex((l) => FETCH.test(l))).toBeLessThan(
			shell.calls.findIndex((l) => SWITCH_NEW.test(l)),
		);
	});

	it("resumes an existing branch of the same nonce instead of failing — a re-run is idempotent", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[REMOTES, okOut("origin\n")],
			[FETCH, okOut("")],
			[RESOLVE, okOut(`${HEAD}\n`)],
			[VERIFY_BRANCH, okOut(`${HEAD}\n`)],
			[/^git switch build\//, okOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runBranch(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls.some((l) => SWITCH_NEW.test(l))).toBe(false);
	});

	it("refuses a flag-shaped slug on 10, before touching git (#4854)", async () => {
		const shell = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, slug: "-rf"}), shell.layer),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'build branch: --slug "-rf" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).',
		);
		expect(shell.calls).toEqual([]);
	});

	it("refuses an unreadable tree root on 11, in its own words", async () => {
		const out = await run([[REV_PARSE, errOut("fatal: not a git repository")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toBe(
			"build branch: cannot read the tree root: fatal: not a git repository — the ground is UNKNOWN.",
		);
	});

	it("refuses a foreign claim on 15 — nothing is cut", async () => {
		const shell = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[ISSUE, issue()],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, WRITE],
		]);
		const out = await Effect.runPromise(Effect.provide(runBranch(options), shell.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(shell.calls.some((l) => /git switch/.test(l))).toBe(false);
	});

	it("refuses a failed fetch on 11 rather than cutting off a stale base", async () => {
		const out = await run([
			...CLAIMED,
			[REMOTES, okOut("origin\n")],
			[FETCH, errOut("fatal: could not read from remote repository")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("refusing to cut a branch off a stale base");
	});

	it("refuses both modes at once, and neither mode at all", async () => {
		const both = await run([], {resume: 4310});
		expect(both.code).toBe(OFF_VOCABULARY);
		const neither = await run([], {number: null, slug: null});
		expect(neither.code).toBe(OFF_VOCABULARY);
	});
});

describe("runBranch — resume mode", () => {
	const RESUME_ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4310$/;
	const RESUME_COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4310\/comments/;
	const PULL_HEAD = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4310$/;
	const resumeOptions = {number: null, slug: null, resume: 4310};

	it("checks the PR's head out under this claim's own local lane name, with the upstream set", async () => {
		const shell = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[RESUME_ISSUE, issue({number: 4310})],
			[RESUME_COMMENTS, MINE],
			[PERM, WRITE],
			[PULL_HEAD, served(pullPayload({number: 4310, head: {ref: "umut/fix-focus", sha: HEAD}}))],
			[REMOTES, okOut("origin\n")],
			[/^git fetch --quiet origin umut\/fix-focus$/, okOut("")],
			[RESOLVE, okOut(`${HEAD}\n`)],
			[VERIFY_BRANCH, errOut("")],
			[SWITCH_NEW, okOut("")],
			[/^git branch --set-upstream-to=origin\/umut\/fix-focus/, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeOptions}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`build/pr-4310-${NONCE}\n`);
		expect(shell.calls).toContain(
			`git branch --set-upstream-to=origin/umut/fix-focus build/pr-4310-${NONCE}`,
		);
	});

	it("refuses a merged PR on 7 — nothing to resume", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[RESUME_ISSUE, issue({number: 4310})],
				[RESUME_COMMENTS, MINE],
				[PERM, WRITE],
				[
					PULL_HEAD,
					served(
						pullPayload({
							number: 4310,
							head: {ref: "umut/fix-focus", sha: HEAD},
							state: "closed",
							merged: true,
						}),
					),
				],
			],
			resumeOptions,
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"build branch: PR #4310 is proven closed or merged — nothing to resume.",
		);
	});
});

/**
 * Child-repair mode: the route a `build claim --resume` on an epic child hands its lane. It has to
 * exist, or the prior-build refusal strands the child it stops (#6386).
 */
describe("runBranch — --resume-lane", () => {
	const FOR_EACH_REF = /^git for-each-ref /;
	const RENAME = /^git branch -m /;
	const SWITCH = /^git switch build\//;
	const WORKTREES = /^git worktree list --porcelain$/;
	const SHOW_CURRENT = /^git branch --show-current$/;
	const PRIOR = "build/4312-path-surface-config-c4367b0b";
	const RESUMED = `build/4312-path-surface-config-${NONCE}`;
	const resumeLaneOptions = {slug: null, resumeLane: true};

	/** Only this tree, on `main` — the branch to take over is free. */
	const FREE = okOut(`worktree /repo\nHEAD ${HEAD}\nbranch refs/heads/main\n`);
	/** A second worktree standing on the prior lane's branch — the case --resume-lane exists for. */
	const HELD = okOut(
		`worktree /repo\nHEAD ${HEAD}\nbranch refs/heads/main\n\nworktree /repo/lane-a\nHEAD ${HEAD}\nbranch refs/heads/${PRIOR}\n`,
	);
	const ON_MAIN = okOut("main\n");
	/** What every take-over asks before it renames: who holds the branch, and am I them. */
	const SAFE_TO_REKEY = [
		[WORKTREES, FREE],
		[SHOW_CURRENT, ON_MAIN],
	] as ReadonlyArray<Scripted>;

	it("re-keys the prior lane's branch to this claim's nonce and checks it out", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`main\n${PRIOR}\nepic/5631\n`)],
			...SAFE_TO_REKEY,
			[RENAME, okOut("")],
			[SWITCH, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`${RESUMED}\n`);
		expect(shell.calls).toContain(`git branch -m ${PRIOR} ${RESUMED}`);
		expect(shell.calls).toContain(`git switch ${RESUMED}`);
		// A second branch carrying the child's commits is the underivable range `lane prove` refuses
		// on, and no cut here is what keeps that from happening.
		expect(shell.calls.some((line) => SWITCH_NEW.test(line))).toBe(false);
	});

	it("fetches nothing — a child's branch is local, and the remote knows none of it", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			...SAFE_TO_REKEY,
			[RENAME, okOut("")],
			[SWITCH, okOut("")],
		]);
		await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(shell.calls.some((line) => /^git fetch/.test(line))).toBe(false);
	});

	it("renames nothing on a re-run under the same nonce — the name already resolves", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${RESUMED}\n`)],
			[SWITCH, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("refuses on 7 when no branch in the clone's refs was cut for the number", async () => {
		const out = await run([...CLAIMED, [FOR_EACH_REF, okOut("main\nepic/5631\n")]], {
			...resumeLaneOptions,
		});
		expect(out.code).toBe(ZERO_SCOPE);
		// Refs are shared clone-wide, so "not in this tree" would name a state that cannot arise —
		// if the branch exists at all, every worktree of the clone sees it.
		expect(out.stderr.at(-1)).toContain("no branch anywhere in this clone's refs");
		expect(out.stderr.at(-1)).not.toContain("resume from that tree");
	});

	it("refuses on 11 when several branches were cut for the number", async () => {
		const out = await run(
			[...CLAIMED, [FOR_EACH_REF, okOut(`${PRIOR}\nbuild/4312-other-shape-11223344\n`)]],
			{...resumeLaneOptions},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("which one this lane resumes is not derivable here");
	});

	/**
	 * Measured against git 2.40.1, not reasoned about: `git branch -m` on a branch a second worktree
	 * holds exits 0 and retargets that worktree's HEAD; only the `git switch` after it fails, 128. So
	 * the refusal has to come BEFORE the rename, or it reports "nothing was changed" over a rename
	 * that landed under another lane (#6386, review round 1).
	 */
	it("refuses on 11 BEFORE renaming when another worktree holds the branch, naming that worktree", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			[WORKTREES, HELD],
			[SHOW_CURRENT, ON_MAIN],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is checked out in the worktree /repo/lane-a");
		expect(out.stderr.at(-1)).toContain("Nothing was changed.");
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("re-keys anyway when the tree holding the branch is this one — nobody else's HEAD moves", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			[WORKTREES, okOut(`worktree /repo\nHEAD ${HEAD}\nbranch refs/heads/${PRIOR}\n`)],
			[SHOW_CURRENT, okOut(`${PRIOR}\n`)],
			[RENAME, okOut("")],
			[SWITCH, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(shell.calls).toContain(`git branch -m ${PRIOR} ${RESUMED}`);
	});

	it("refuses on 11 when who holds the branch cannot be read — never 'free'", async () => {
		const shell = fakeSeams([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			[WORKTREES, errOut("fatal: not a git repository")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("could silently retarget another lane's HEAD");
		expect(shell.calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("says the rename stands when the switch fails after it — never 'nothing was changed'", async () => {
		const out = await run(
			[
				...CLAIMED,
				[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
				...SAFE_TO_REKEY,
				[RENAME, okOut("")],
				[SWITCH, errOut(`fatal: '${RESUMED}' is already checked out at '/repo/lane-b'`)],
			],
			{...resumeLaneOptions},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(`${PRIOR} WAS re-keyed to ${RESUMED}`);
		expect(out.stderr.at(-1)).not.toContain("nothing was changed");
	});

	it("refuses --resume-lane beside --resume on 10 — a child has no PR to resume", async () => {
		const out = await run([], {number: null, slug: null, resume: 4310, resumeLane: true});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("it cannot be combined with --resume <pr>");
	});

	it("refuses --resume-lane beside --slug on 10 — the slug comes off the branch", async () => {
		const out = await run([], {resumeLane: true});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("reads the slug off the branch it takes over");
	});
});
