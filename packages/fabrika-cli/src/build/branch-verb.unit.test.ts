import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runBranch} from "./branch-verb.ts";
import {CLAIM_NOT_MINE, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	comments,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NONCE,
} from "./fixtures.test-support.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const REMOTES = /^git remote$/;
const FETCH = /^git fetch --quiet origin main$/;
const RESOLVE = /^git rev-parse --verify --quiet FETCH_HEAD/;
const VERIFY_BRANCH = /^git rev-parse --verify --quiet refs\/heads\//;
const SWITCH_NEW = /^git switch -c /;

const MINE = comments({id: 1, body: marker("s-9f2e", LANE_UUID)});

const options = {
	number: 4312 as number | null,
	slug: "editor-focus-loss" as string | null,
	base: "origin/main",
	resume: null as number | null,
	resumeLane: false,
	token: LANE_TOKEN,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

const CLAIMED: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, GIT_DIRS],
	[ISSUE, issue()],
	[COMMENTS, MINE],
	[PERM, okOut("write\n")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runBranch({...options, ...overrides}), fakeShell(script).layer));

describe("runBranch — create mode", () => {
	it("cuts the lane branch off FETCH_HEAD and prints its name", async () => {
		const shell = fakeShell([
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
		const shell = fakeShell([
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
		const shell = fakeShell([
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
		const shell = fakeShell([]);
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
		const shell = fakeShell([
			[REV_PARSE, GIT_DIRS],
			[ISSUE, issue()],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, okOut("write\n")],
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
	const RESUME_ISSUE = /^gh api repos\/o\/r\/issues\/4310$/;
	const RESUME_COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4310\/comments/;
	const PULL_HEAD = /^gh api repos\/o\/r\/pulls\/4310 --jq/;
	const resumeOptions = {number: null, slug: null, resume: 4310};

	it("checks the PR's head out under this claim's own local lane name, with the upstream set", async () => {
		const shell = fakeShell([
			[REV_PARSE, GIT_DIRS],
			[RESUME_ISSUE, issue({number: 4310})],
			[RESUME_COMMENTS, MINE],
			[PERM, okOut("write\n")],
			[PULL_HEAD, okOut(`umut/fix-focus\t${HEAD}\topen\tfalse\n`)],
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
				[PERM, okOut("write\n")],
				[PULL_HEAD, okOut(`umut/fix-focus\t${HEAD}\tclosed\ttrue\n`)],
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
	const PRIOR = "build/4312-path-surface-config-c4367b0b";
	const RESUMED = `build/4312-path-surface-config-${NONCE}`;
	const resumeLaneOptions = {slug: null, resumeLane: true};

	it("re-keys the prior lane's branch to this claim's nonce and checks it out", async () => {
		const shell = fakeShell([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`main\n${PRIOR}\nepic/5631\n`)],
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
		const shell = fakeShell([
			...CLAIMED,
			[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
			[RENAME, okOut("")],
			[SWITCH, okOut("")],
		]);
		await Effect.runPromise(
			Effect.provide(runBranch({...options, ...resumeLaneOptions}), shell.layer),
		);
		expect(shell.calls.some((line) => /^git fetch/.test(line))).toBe(false);
	});

	it("renames nothing on a re-run under the same nonce — the name already resolves", async () => {
		const shell = fakeShell([
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

	it("refuses on 7 when no local branch was cut for the number", async () => {
		const out = await run([...CLAIMED, [FOR_EACH_REF, okOut("main\nepic/5631\n")]], {
			...resumeLaneOptions,
		});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("no local branch in this tree was cut for #4312");
	});

	it("refuses on 11 when several branches were cut for the number", async () => {
		const out = await run(
			[...CLAIMED, [FOR_EACH_REF, okOut(`${PRIOR}\nbuild/4312-other-shape-11223344\n`)]],
			{...resumeLaneOptions},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("which one this lane resumes is not derivable here");
	});

	it("refuses on 11 when the re-key fails, naming the worktree that holds the branch", async () => {
		const out = await run(
			[
				...CLAIMED,
				[FOR_EACH_REF, okOut(`${PRIOR}\n`)],
				[RENAME, errOut(`fatal: '${PRIOR}' is checked out at another worktree`)],
			],
			{...resumeLaneOptions},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the prior lane's worktree is likely still standing on it");
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
