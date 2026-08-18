import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {CLAIM_NOT_MINE, DIRTY_TREE, PRECONDITION_UNKNOWN, WRONG_LANE} from "./codes.ts";
import {comments, GIT_DIRS, issue, LANE_UUID, marker, NONCE} from "./fixtures.test-support.ts";
import {runTree} from "./tree-verb.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const STATUS = /^git status --porcelain$/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;

const LANE_BRANCH = okOut(`build/4312-editor-focus-loss-${NONCE}\n`);
const MINE = comments({id: 1, body: marker("s-9f2e", LANE_UUID)});

const options = {
	requireClean: false,
	issue: null as number | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runTree({...options, ...overrides}), fakeShell(script).layer));

describe("runTree", () => {
	it("prints the tree root when the git dir and the common dir differ", async () => {
		const out = await run([[REV_PARSE, GIT_DIRS]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("/repo/trees/lane-a\n");
	});

	it("refuses an unreadable git state on 11 — the ground is UNKNOWN, never a verdict", async () => {
		const out = await run([[REV_PARSE, errOut("fatal: not a git repository")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the tree root");
	});

	it("refuses a dirty tree at a --require-clean open on 13, and never cleans it", async () => {
		const shell = fakeShell([
			[REV_PARSE, GIT_DIRS],
			[STATUS, okOut(" M apps/web/src/App.tsx\n?? scratch.md\n")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runTree({...options, requireClean: true}), shell.layer),
		);
		expect(out.code).toBe(DIRTY_TREE);
		expect(out.stderr.at(-1)).toBe(
			"build tree: 2 uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.",
		);
		expect(shell.calls.some((line) => /git (checkout|clean|restore|stash)/.test(line))).toBe(false);
	});

	it("passes --require-clean over a clean tree", async () => {
		const out = await run([
			[REV_PARSE, GIT_DIRS],
			[STATUS, okOut("")],
		]);
		expect(out.code).toBe(0);
	});

	it("proves the lane with --issue when the branch nonce matches the claim", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[ISSUE, issue()],
				[COMMENTS, MINE],
				[PERM, okOut("write\n")],
				[BRANCH, LANE_BRANCH],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("/repo/trees/lane-a\n");
	});

	it("refuses a branch carrying another claim's nonce on 14", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[ISSUE, issue()],
				[COMMENTS, MINE],
				[PERM, okOut("write\n")],
				[BRANCH, okOut("build/4312-editor-focus-loss-deadbeef\n")],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("does not carry claim build:s-9f2e:");
	});

	it("refuses a foreign claim on 15", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[ISSUE, issue()],
				[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
				[PERM, okOut("write\n")],
				[BRANCH, LANE_BRANCH],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			`build tree: #4312 is held by build:s-77aa:${LANE_UUID}, not by the lane on nonce ${NONCE}.`,
		);
	});

	it("refuses an unreadable marker set on 11 — the lane is UNKNOWN, never unclaimed", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[ISSUE, issue()],
				[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
				[BRANCH, LANE_BRANCH],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the lane is UNKNOWN");
	});

	it("refuses a missing session id on 1, never on 15", async () => {
		const out = await run([[REV_PARSE, GIT_DIRS]], {
			issue: 4312,
			env: {CLAUDE_PIPELINE_REPO: "o/r"},
		});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("CLAUDE_CODE_SESSION_ID is unset");
	});
});
