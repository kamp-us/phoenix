import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLAIM_NOT_MINE,
	EMPTY_STDIN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	pull,
	pullPayload,
	served,
} from "./fixtures.test-support.ts";
import {runPr, runPrBody} from "./pr-verb.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;
const OPEN_PULLS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?state=open&head=/;
const REPO_META = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;
const CREATE = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/pulls$/;
const READ_BACK = /^GET \S+\/repos\/o\/r\/pulls\/4318$/;

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const BODY = "Fixes #4312\n\nEditor focus now survives a save.\n\n## Deviations\nNone.\n";

const LANE_OK: ReadonlyArray<Scripted> = [
	[ISSUE, issue()],
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
];

const options = {
	number: 4312,
	partial: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runPr({...options, ...overrides}), fakeSeams(script).layer));

const withBody = (text: string) => ({stdin: Effect.succeed<StdinRead>({_tag: "Text", text})});

describe("runPr — the body guards run before any write", () => {
	it("refuses empty stdin on 3, and touches nothing", async () => {
		const shell = fakeSeams([]);
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
			'build pr: the body\'s "## Deviations" section is not readable — no heading in the body reaches for "## Deviations". State each deviation as an entry, or state "None."',
		);
	});

	it("refuses a stray closing keyword on 4 (#4471)", async () => {
		const out = await run(
			[],
			withBody(BODY.replace("## Deviations", "Also closes #999.\n\n## Deviations")),
		);
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
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({number: 4318, html_url: "https://github.com/o/r/pull/4318"})],
			[READ_BACK, pull({body: BODY})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "opened",
			number: 4318,
			url: "https://github.com/o/r/pull/4318",
		});
	});

	it("sends the body as the request's own JSON, never a path the transport would read (#4683)", async () => {
		const shell = fakeSeams([
			...LANE_OK,
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({number: 4318, html_url: "https://github.com/o/r/pull/4318"})],
			[READ_BACK, pull({body: BODY})],
		]);
		await Effect.runPromise(Effect.provide(runPr(options), shell.layer));
		const create = shell.requests.findIndex((line) => CREATE.test(line));
		expect(JSON.parse(shell.bodies[create] ?? "null")).toMatchObject({body: BODY});
	});

	it("answers `existing` on exit 0 when this head already has an open PR — no duplicate", async () => {
		const shell = fakeSeams([
			...LANE_OK,
			[OPEN_PULLS, served([{number: 4310, html_url: "https://github.com/o/r/pull/4310"}])],
		]);
		const out = await Effect.runPromise(Effect.provide(runPr(options), shell.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("existing");
		expect(shell.requests.some((line) => CREATE.test(line))).toBe(false);
	});

	it("refuses a failed create on 8, pointing at the idempotent re-run", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({message: "Gateway timeout"}, 504)],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("re-run, the verb re-checks for an existing PR first");
	});

	it("refuses a body that does not read back on 9", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({number: 4318, html_url: "https://github.com/o/r/pull/4318"})],
			[READ_BACK, pull({body: "something else"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	/** GitHub's round-tripping is not byte-stable; comparing raw bytes would red on a clean run. */
	it("compares the read-back through normalizeForReadback, not byte-for-byte", async () => {
		const out = await run([
			...LANE_OK,
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({number: 4318, html_url: "https://github.com/o/r/pull/4318"})],
			[READ_BACK, pull({body: `${BODY.replace(/\n/g, "\r\n")}\r\n\r\n`})],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses a closed target issue on 7", async () => {
		const out = await run([[once(ISSUE), issue({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

const PULL_HEAD = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4318$/;
const PATCH_BODY = /^PATCH https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4318$/;

/**
 * The head read, scripted to answer once.
 *
 * The head probe and the read-back hit the same endpoint, so a row that matched forever would
 * answer the read-back with the payload the probe was scripted with — and every read-back test
 * would compare the body against itself.
 */
const head = (overrides: {ref?: string; state?: string; merged?: boolean} = {}): Scripted => [
	once(PULL_HEAD),
	served(
		pullPayload({
			number: 4318,
			head: {ref: overrides.ref ?? LANE, sha: HEAD},
			state: overrides.state ?? "open",
			merged: overrides.merged ?? false,
		}),
	),
];

const PATCHED = served({number: 4318, html_url: "https://github.com/o/r/pull/4318"});

/** The lane reads `runPrBody` makes — `build pr`'s minus the served issue, which it never fetches. */
const LANE_ONLY: ReadonlyArray<Scripted> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
];

const bodyOptions = {
	pr: 4318,
	partial: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

const runBody = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof bodyOptions> = {}) =>
	Effect.runPromise(
		Effect.provide(runPrBody({...bodyOptions, ...overrides}), fakeSeams(script).layer),
	);

describe("runPrBody — the guarded body-only repair (#5618)", () => {
	it("replaces an open PR's body and reads it back, moving no ref", async () => {
		const shell = fakeSeams([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, PATCHED],
			[READ_BACK, pull({body: BODY})],
		]);
		const out = await Effect.runPromise(Effect.provide(runPrBody(bodyOptions), shell.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "updated",
			number: 4318,
			url: "https://github.com/o/r/pull/4318",
		});
		expect(shell.requests.some((line) => CREATE.test(line))).toBe(false);
		expect(shell.calls.some((line) => line.startsWith("git push"))).toBe(false);
	});

	it("sends the body as the request's own JSON, never a path the transport would read (#4683)", async () => {
		const shell = fakeSeams([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, PATCHED],
			[READ_BACK, pull({body: BODY})],
		]);
		await Effect.runPromise(Effect.provide(runPrBody(bodyOptions), shell.layer));
		const patch = shell.requests.findIndex((line) => PATCH_BODY.test(line));
		expect(JSON.parse(shell.bodies[patch] ?? "null")).toEqual({body: BODY});
	});

	it("refuses empty stdin on 3, and touches nothing", async () => {
		const shell = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPrBody({...bodyOptions, stdin: Effect.succeed<StdinRead>({_tag: "Text", text: " \n"})}),
				shell.layer,
			),
		);
		expect(out.code).toBe(EMPTY_STDIN);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a bare @ reference on 6", async () => {
		const out = await runBody([], {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "@/tmp/pr-body.md"}),
		});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path on 5, before any read", async () => {
		const shell = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPrBody({
					...bodyOptions,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: "Fixes #4312\n\nsee /Users/someone/notes.md\n\n## Deviations\nNone.\n",
					}),
				}),
				shell.layer,
			),
		);
		expect(out.code).toBe(LEAKED_PATH);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a malformed Deviations section on 4 — the FAIL this verb exists for", async () => {
		const shell = fakeSeams([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, PATCHED],
			[READ_BACK, pull({body: BODY})],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPrBody({
					...bodyOptions,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: "Fixes #4312\n\n## Deviations\n\n- narrowed the scope a bit.\n",
					}),
				}),
				shell.layer,
			),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toContain('build pr-body: the body\'s "## Deviations" section');
		expect(shell.requests.some((line) => PATCH_BODY.test(line))).toBe(false);
	});

	it("refuses a stray closing keyword on 4, naming the issue read off the head branch", async () => {
		const out = await runBody([...LANE_ONLY, head()], {
			stdin: Effect.succeed<StdinRead>({
				_tag: "Text",
				text: BODY.replace("## Deviations", "Also closes #999.\n\n## Deviations"),
			}),
		});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			"build pr-body: the body carries a closing keyword aimed at #999 — this PR serves #4312.",
		);
	});

	it("refuses Fixes under --partial on 4", async () => {
		const out = await runBody([...LANE_ONLY, head()], {partial: true});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			'build pr-body: the body says "Fixes #4312" but --partial was given — a partial PR must say "Part of #4312".',
		);
	});

	it("refuses a control-plane classification on 10, before any read", async () => {
		const shell = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPrBody({
					...bodyOptions,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: "Fixes #4312\n\nThis is not control-plane.\n\n## Deviations\nNone.\n",
					}),
				}),
				shell.layer,
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"build pr-body: the body asserts a control-plane classification — that verdict is the merge gate's.",
		);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a closed PR on 7 — there is no body to rewrite", async () => {
		const out = await runBody([...LANE_ONLY, head({state: "closed"})]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("refuses an unreadable PR on 11, never on 7", async () => {
		const out = await runBody([...LANE_ONLY, [PULL_HEAD, GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a PR whose head is not a lane branch on 14", async () => {
		const out = await runBody([...LANE_ONLY, head({ref: "someone/hotfix"})]);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("is not a lane branch");
	});

	it("refuses when the checked-out lane does not serve this PR on 14", async () => {
		const other = `build/9999-other-lane-${NONCE}`;
		const out = await runBody([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`${other}\n`)],
			[
				/^GET \S+\/repos\/o\/r\/issues\/9999\/comments/,
				comments({id: 1, body: marker("s-9f2e", LANE_UUID)}),
			],
			[PERM, WRITE],
			head(),
		]);
		expect(out.code).toBe(WRONG_LANE);
		expect(out.stderr.at(-1)).toContain("does not serve PR #4318");
	});

	it("refuses without a held claim on 15, before any write", async () => {
		const shell = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`${LANE}\n`)],
			[COMMENTS, comments()],
			[PERM, WRITE],
			head(),
			[PATCH_BODY, PATCHED],
		]);
		const out = await Effect.runPromise(Effect.provide(runPrBody(bodyOptions), shell.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(shell.requests.some((line) => PATCH_BODY.test(line))).toBe(false);
	});

	it("refuses a failed update on 8 — UNKNOWN, pointing at a re-read", async () => {
		const out = await runBody([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, served({message: "Gateway timeout"}, 504)],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("re-read PR #4318 before retrying");
	});

	it("refuses a body that does not read back on 9", async () => {
		const out = await runBody([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, PATCHED],
			[READ_BACK, pull({body: "something else"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("does not read back as sent");
	});

	it("compares the read-back through normalizeForReadback, not byte-for-byte", async () => {
		const out = await runBody([
			...LANE_ONLY,
			head(),
			[PATCH_BODY, PATCHED],
			[READ_BACK, pull({body: `${BODY.replace(/\n/g, "\r\n")}\r\n\r\n`})],
		]);
		expect(out.code).toBe(0);
	});
});
