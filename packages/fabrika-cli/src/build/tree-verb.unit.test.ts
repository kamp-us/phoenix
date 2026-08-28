import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	DIRTY_TREE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	WRONG_LANE,
} from "./codes.ts";
import {
	comments,
	GATEWAY,
	GIT_DIRS,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	pull,
	served,
} from "./fixtures.test-support.ts";
import {runTree} from "./tree-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const STATUS = /^git status --porcelain$/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;
const REPAIR_CLAIM = /GET .*\/repos\/o\/r\/issues\/7182$/;
const REPAIR_COMMENTS = /GET .*\/repos\/o\/r\/issues\/7182\/comments/;
const REPAIR_PULL = /GET .*\/repos\/o\/r\/pulls\/7182$/;
const SERVED_ISSUE = /GET .*\/repos\/o\/r\/issues\/7181$/;

const LANE_BRANCH = okOut(`build/4312-editor-focus-loss-${NONCE}\n`);
const MINE = comments({id: 1, body: marker("s-9f2e", LANE_UUID)});

const options = {
	requireClean: false,
	issue: null as number | null,
	repair: null as number | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runTree({...options, ...overrides}), fakeSeams(script).layer));

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
		const seams = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[STATUS, okOut(" M apps/web/src/App.tsx\n?? scratch.md\n")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runTree({...options, requireClean: true}), seams.layer),
		);
		expect(out.code).toBe(DIRTY_TREE);
		expect(out.stderr.at(-1)).toBe(
			"build tree: 2 uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.",
		);
		expect(seams.calls.some((line) => /git (checkout|clean|restore|stash)/.test(line))).toBe(false);
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
				[PERM, WRITE],
				[BRANCH, LANE_BRANCH],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "proven",
			root: "/repo/trees/lane-a",
			branch: `build/4312-editor-focus-loss-${NONCE}`,
			claim: {number: 4312, nonce: NONCE},
			servedIssue: {number: 4312, kind: "issue"},
		});
	});

	it("refuses a fresh branch naming another issue on 14", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, okOut(`build/9999-editor-focus-loss-${NONCE}\n`)],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("not issue #4312");
	});

	it("refuses a branch carrying another claim's nonce on 14", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[ISSUE, issue()],
				[COMMENTS, MINE],
				[PERM, WRITE],
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
				[PERM, WRITE],
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
				[COMMENTS, GATEWAY],
				[BRANCH, LANE_BRANCH],
			],
			{issue: 4312},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the lane is UNKNOWN");
	});

	it("refuses --repair without --issue on 10", async () => {
		const out = await run([[REV_PARSE, GIT_DIRS]], {repair: 7182});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("requires --issue");
	});

	it("refuses a missing session id on 1, never on 15", async () => {
		const out = await run([[REV_PARSE, GIT_DIRS]], {
			issue: 4312,
			env: {CLAUDE_PIPELINE_REPO: "o/r"},
		});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain(
			"no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID, PI_SUBAGENT_PARENT_SESSION are all unset",
		);
	});

	const repairBranch = okOut(`build/pr-7182-${NONCE}\n`);
	const repairClaim = issue({
		number: 7182,
		title: "repair PR",
		html_url: "https://github.com/o/r/pull/7182",
		body: "Fixes #7181\n\n## Deviations\nNone.\n",
		pull_request: {url: "https://api.github.com/repos/o/r/pulls/7182"},
	});
	const repairMine = comments({id: 7182, body: marker("s-9f2e", LANE_UUID)});
	const repairPull = (body = "Fixes #7181\n\n## Deviations\nNone.\n") => pull({number: 7182, body});
	const servedIssue = issue({number: 7181, html_url: "https://github.com/o/r/issues/7181"});
	const repairProof = (body?: string): ReadonlyArray<Scripted> => [
		[REV_PARSE, GIT_DIRS],
		[BRANCH, repairBranch],
		[REPAIR_CLAIM, repairClaim],
		[REPAIR_COMMENTS, repairMine],
		[PERM, WRITE],
		[REPAIR_PULL, repairPull(body)],
		[SERVED_ISSUE, servedIssue],
	];

	it("proves issue #7181 through PR #7182's winning claim and resumed branch", async () => {
		const out = await run(repairProof(), {issue: 7181, repair: 7182});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "proven",
			root: "/repo/trees/lane-a",
			branch: `build/pr-7182-${NONCE}`,
			claim: {number: 7182, nonce: NONCE},
			servedIssue: {number: 7181, kind: "fixes"},
		});
	});

	it("retains issue #7162 / PR #7180 as distinct repair identifiers", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, okOut(`build/pr-7180-${NONCE}\n`)],
				[
					/GET .*\/repos\/o\/r\/issues\/7180$/,
					issue({
						number: 7180,
						title: "existing repair PR",
						html_url: "https://github.com/o/r/pull/7180",
						body: "Fixes #7162\n\n## Deviations\nNone.\n",
						pull_request: {url: "https://api.github.com/repos/o/r/pulls/7180"},
					}),
				],
				[
					/GET .*\/repos\/o\/r\/issues\/7180\/comments/,
					comments({id: 7180, body: marker("s-9f2e", LANE_UUID)}),
				],
				[PERM, WRITE],
				[
					/GET .*\/repos\/o\/r\/pulls\/7180$/,
					pull({
						number: 7180,
						body: "Fixes #7162\n\n## Deviations\nNone.\n",
					}),
				],
				[
					/GET .*\/repos\/o\/r\/issues\/7162$/,
					issue({
						number: 7162,
						html_url: "https://github.com/o/r/issues/7162",
					}),
				],
			],
			{issue: 7162, repair: 7180},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			claim: {number: 7180},
			servedIssue: {number: 7162},
		});
	});

	it("refuses a wrong repair PR branch before reading claim or linkage", async () => {
		const seams = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`build/pr-7180-${NONCE}\n`)],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runTree({...options, issue: 7181, repair: 7182}), seams.layer),
		);
		expect(out.code).toBe(WRONG_LANE);
		expect(seams.calls.some((call) => call.includes("/issues/7182"))).toBe(false);
	});

	it("refuses a repair nonce that does not own the PR claim on 14", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
				[REPAIR_CLAIM, repairClaim],
				[
					REPAIR_COMMENTS,
					comments({id: 7182, body: marker("s-9f2e", "deadbeef-3b7e-4a19-9c2d-5e8f0a1b2c3d")}),
				],
				[PERM, WRITE],
			],
			{issue: 7181, repair: 7182},
		);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("does not carry claim");
	});

	it("refuses a PR serving another issue on 14", async () => {
		const out = await run(repairProof("Fixes #7162\n\n## Deviations\nNone.\n"), {
			issue: 7181,
			repair: 7182,
		});
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("serves issue #7162, not requested issue #7181");
	});

	it.each([
		["no linkage", "Summary only\n\n## Deviations\nNone.\n", 0],
		["ambiguous linkage", "Fixes #7181\nFixes #7162\n\n## Deviations\nNone.\n", 2],
	])("refuses %s on 4", async (_name, body, count) => {
		const out = await run(repairProof(body), {issue: 7181, repair: 7182});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toContain(`names ${count} served issues`);
	});

	it("refuses unreadable PR claim state on 11", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
				[REPAIR_CLAIM, repairClaim],
				[REPAIR_COMMENTS, GATEWAY],
			],
			{issue: 7181, repair: 7182},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the lane is UNKNOWN");
	});

	it("refuses unreadable PR linkage on 11", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
				[REPAIR_CLAIM, repairClaim],
				[REPAIR_COMMENTS, repairMine],
				[PERM, WRITE],
				[REPAIR_PULL, GATEWAY],
			],
			{issue: 7181, repair: 7182},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("served issue is UNKNOWN");
	});

	it("refuses an unreadable served issue on 11", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
				[REPAIR_CLAIM, repairClaim],
				[REPAIR_COMMENTS, repairMine],
				[PERM, WRITE],
				[REPAIR_PULL, repairPull()],
				[SERVED_ISSUE, GATEWAY],
			],
			{issue: 7181, repair: 7182},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("repair subject is UNKNOWN");
	});

	it("does not accept the PR number as the served issue", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
				[REPAIR_CLAIM, repairClaim],
				[REPAIR_COMMENTS, repairMine],
				[PERM, WRITE],
				[REPAIR_PULL, repairPull("Fixes #7182\n\n## Deviations\nNone.\n")],
				[REPAIR_CLAIM, repairClaim],
			],
			{issue: 7182, repair: 7182},
		);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("that record is itself a pull request");
	});

	it("does not accept the served issue as the repair claim subject", async () => {
		const out = await run(
			[
				[REV_PARSE, GIT_DIRS],
				[BRANCH, repairBranch],
			],
			{issue: 7181, repair: 7181},
		);
		expect(out.code).toBe(WRONG_LANE);
	});
});
