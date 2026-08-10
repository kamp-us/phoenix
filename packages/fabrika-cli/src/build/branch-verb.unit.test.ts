import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runBranch} from "./branch-verb.ts";
import {
	CLAIM_NOT_MINE,
	NOT_A_WORKTREE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	HEAD,
	issue,
	LANE_UUID,
	LINKED,
	marker,
	NONCE,
	PRIMARY,
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
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

const CLAIMED: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
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

	it("refuses the primary checkout on 12, in its own words", async () => {
		const out = await run([[REV_PARSE, PRIMARY]]);
		expect(out.code).toBe(NOT_A_WORKTREE);
		expect(out.stderr.at(-1)).toBe(
			"build branch: this is the primary checkout — refusing to branch here.",
		);
	});

	it("refuses a foreign claim on 15 — nothing is cut", async () => {
		const shell = fakeShell([
			[REV_PARSE, LINKED],
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
			[REV_PARSE, LINKED],
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
				[REV_PARSE, LINKED],
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
