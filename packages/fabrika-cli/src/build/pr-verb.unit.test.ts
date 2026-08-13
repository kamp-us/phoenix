import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GIT_DIRS,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	pull,
} from "./fixtures.test-support.ts";
import {runPr} from "./pr-verb.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const OPEN_PULLS = /^gh api --paginate repos\/o\/r\/pulls\?state=open&head=/;
const REPO_META = /^gh api repos\/o\/r --jq \.default_branch$/;
const CREATE = /^gh api --method POST repos\/o\/r\/pulls/;
const READ_BACK = /^gh api repos\/o\/r\/pulls\/4318$/;

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const BODY = "Fixes #4312\n\nEditor focus now survives a save.\n\n## Deviations\nNone.\n";

const LANE_OK: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[ISSUE, issue()],
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, okOut("write\n")],
];

const options = {
	number: 4312,
	partial: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runPr({...options, ...overrides}), fakeShell(script).layer));

const withBody = (text: string) => ({stdin: Effect.succeed<StdinRead>({_tag: "Text", text})});

describe("runPr — the body guards run before any write", () => {
	it("refuses empty stdin on 3, and touches nothing", async () => {
		const shell = fakeShell([]);
		const out = await Effect.runPromise(
			Effect.provide(runPr({...options, ...withBody("   \n")}), shell.layer),
		);
		expect(out.code).toBe(EMPTY_STDIN);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a bare @ reference on 6 — the body never arrived (#3086)", async () => {
		const out = await run([], withBody("@/tmp/pr-body.md"));
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path on 5, naming the first hit", async () => {
		const out = await run(
			[],
			withBody("Fixes #4312\n\nsee /Users/someone/notes.md\n\n## Deviations\nNone.\n"),
		);
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.at(-1)).toContain("redact before posting");
	});

	it("refuses a missing Deviations section on 4 (#4542)", async () => {
		const out = await run([], withBody("Fixes #4312\n\njust prose\n"));
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			'build pr: the body has no "## Deviations" heading, or it is empty — state deviations, or state "None."',
		);
	});

	it("refuses a stray closing keyword on 4 (#4471)", async () => {
		const out = await run([], withBody(`${BODY}\nAlso closes #999.\n`));
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			"build pr: the body carries a closing keyword aimed at #999 — this PR serves #4312.",
		);
	});

	it("refuses Fixes under --partial on 4", async () => {
		const out = await run([], {partial: true});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			'build pr: the body says "Fixes #4312" but --partial was given — a partial PR must say "Part of #4312".',
		);
	});

	it("refuses a control-plane classification on 10 — that verdict is the gate's (#4153)", async () => {
		const out = await run(
			[],
			withBody("Fixes #4312\n\nThis is not control-plane.\n\n## Deviations\nNone.\n"),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"build pr: the body asserts a control-plane classification — that verdict is the merge gate's.",
		);
	});
});

describe("runPr — the write path", () => {
	it("opens the PR and reads its body back", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, okOut("")],
			[REPO_META, okOut("main\n")],
			[CREATE, okOut(JSON.stringify({number: 4318, html_url: "https://github.com/o/r/pull/4318"}))],
			[READ_BACK, pull({body: BODY})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "opened",
			number: 4318,
			url: "https://github.com/o/r/pull/4318",
		});
	});

	it("never posts the body through the `-f body=@file` form (#4683)", async () => {
		const shell = fakeShell([
			...LANE_OK,
			[OPEN_PULLS, okOut("")],
			[REPO_META, okOut("main\n")],
			[CREATE, okOut(JSON.stringify({number: 4318, html_url: "https://github.com/o/r/pull/4318"}))],
			[READ_BACK, pull({body: BODY})],
		]);
		await Effect.runPromise(Effect.provide(runPr(options), shell.layer));
		expect(shell.calls.some((line) => line.includes("body=@"))).toBe(false);
	});

	it("answers `existing` on exit 0 when this head already has an open PR — no duplicate", async () => {
		const shell = fakeShell([
			...LANE_OK,
			[OPEN_PULLS, okOut("4310\thttps://github.com/o/r/pull/4310\n")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPr(options), shell.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("existing");
		expect(shell.calls.some((line) => CREATE.test(line))).toBe(false);
	});

	it("refuses a failed create on 8, pointing at the idempotent re-run", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, okOut("")],
			[REPO_META, okOut("main\n")],
			[CREATE, errOut("gh: Gateway timeout (HTTP 504)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("re-run, the verb re-checks for an existing PR first");
	});

	it("refuses a body that does not read back on 9", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, okOut("")],
			[REPO_META, okOut("main\n")],
			[CREATE, okOut(JSON.stringify({number: 4318, html_url: "https://github.com/o/r/pull/4318"}))],
			[READ_BACK, pull({body: "something else"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	/** GitHub's round-tripping is not byte-stable; comparing raw bytes would red on a clean run. */
	it("compares the read-back through normalizeForReadback, not byte-for-byte", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, okOut("")],
			[REPO_META, okOut("main\n")],
			[CREATE, okOut(JSON.stringify({number: 4318, html_url: "https://github.com/o/r/pull/4318"}))],
			[READ_BACK, pull({body: `${BODY.replace(/\n/g, "\r\n")}\r\n\r\n`})],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses a closed target issue on 7", async () => {
		const out = await run([[once(ISSUE), issue({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
