import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	CLAIM_NOT_MINE,
	EMPTY_STDIN,
	LEAKED_PATH,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GH_TOKEN_ENV,
	HEAD,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NOT_FOUND,
	pull,
	served,
} from "./fixtures.test-support.ts";
import {headStamp, runNote} from "./note-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const IS_PULL = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4310$/;
const PULL = /GET .*\/repos\/o\/r\/pulls\/4310$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4310\/comments/;
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;
const POST = /POST .*\/repos\/o\/r\/issues\/4310\/comments/;
const GET_COMMENT = /GET .*\/repos\/o\/r\/issues\/comments\/512346$/;

const TEXT = "Round 2 findings addressed: focus restore moved out of the render path.";
const STAMPED = `${TEXT}\n\n${headStamp(HEAD)}`;

const CLAIMED: ReadonlyArray<Scripted> = [
	[IS_PULL, served({number: 4310, pull_request: {url: "…"}})],
	[PULL, pull({number: 4310})],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
];

const POSTED = served({id: 512346, html_url: "https://github.com/o/r/pull/4310#c"}, 201);

const options = {
	number: 4310,
	token: LANE_TOKEN,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: TEXT}),
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runNote({...options, ...overrides}), fakeSeams(script).layer));

describe("runNote", () => {
	it("stamps a note on a PR with that PR's head SHA (#4808)", async () => {
		const seams = fakeSeams([...CLAIMED, [POST, POSTED], [GET_COMMENT, served({body: STAMPED})]]);
		const out = await Effect.runPromise(Effect.provide(runNote(options), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "posted",
			number: 4310,
			commentId: 512346,
			head: HEAD,
		});
		expect(seams.bodies.some((body) => body.includes(`— at ${HEAD}`))).toBe(true);
	});

	it("does not stamp a note on a plain issue, and reports head null", async () => {
		const out = await run([
			[IS_PULL, served({number: 4310})],
			[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
			[PERM, WRITE],
			[POST, POSTED],
			[GET_COMMENT, served({body: TEXT})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).head).toBeNull();
	});

	/**
	 * The load-bearing asymmetry with the sibling verbs: a stop-report has to stay postable from a tree
	 * `build tree` just refused, so this verb never runs the tree assertions.
	 */
	it("never runs the tree assertions — a refused tree does not silence the report", async () => {
		const seams = fakeSeams([...CLAIMED, [POST, POSTED], [GET_COMMENT, served({body: STAMPED})]]);
		await Effect.runPromise(Effect.provide(runNote(options), seams.layer));
		expect(seams.calls.some((line) => /git rev-parse|git status/.test(line))).toBe(false);
	});

	it("refuses empty stdin on 3", async () => {
		const out = await run([], {stdin: Effect.succeed<StdinRead>({_tag: "Text", text: ""})});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it("refuses a bare @ reference on 6", async () => {
		const out = await run([], {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "@/tmp/note.md"}),
		});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path on 5, and posts nothing", async () => {
		const seams = fakeSeams(CLAIMED);
		const out = await Effect.runPromise(
			Effect.provide(
				runNote({
					...options,
					stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "see /Users/someone/log.txt"}),
				}),
				seams.layer,
			),
		);
		expect(out.code).toBe(LEAKED_PATH);
		expect(seams.requests.some((request) => POST.test(request))).toBe(false);
	});

	it("refuses a proven-absent target on 7", async () => {
		const out = await run([[IS_PULL, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"build note: #4310 is proven absent or closed — nothing to post to.",
		);
	});

	it("refuses a foreign claim on 15, and posts nothing", async () => {
		const seams = fakeSeams([
			[IS_PULL, served({number: 4310, pull_request: {url: "…"}})],
			[PULL, pull({number: 4310})],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, WRITE],
		]);
		const out = await Effect.runPromise(Effect.provide(runNote(options), seams.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(seams.requests.some((request) => POST.test(request))).toBe(false);
	});

	it("refuses a failed write on 8 — UNKNOWN whether it landed", async () => {
		const out = await run([...CLAIMED, [POST, {status: 504, body: "{}"}]]);
		expect(out.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses a note that does not read back on 9", async () => {
		const out = await run([
			...CLAIMED,
			[POST, POSTED],
			[GET_COMMENT, served({body: "something else"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
