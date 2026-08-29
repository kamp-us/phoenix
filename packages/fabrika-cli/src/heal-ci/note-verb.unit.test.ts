import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {FAILED} from "../verb.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	INCOMPLETE_SCAN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	commentBody,
	comments,
	createdComment,
	ENV,
	HEAD,
	OTHER_HEAD,
	pull,
} from "./fixtures.test-support.ts";
import {keyOf, renderKey, withKey} from "./note-key.ts";
import {runNote} from "./note-verb.ts";

const BODY = `heal-ci: ROUTED — PR #4321 @ ${HEAD} → ship\n\nGate satisfied, CI green, nobody holding it.\n`;
const CLASS = "gated-unshipped";
const KEY = keyOf(4321, CLASS, HEAD);
/** What the verb actually posts: the authored note with the machine marker as its last line. */
const POSTED = withKey(BODY, KEY);

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const LIST_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4321\/comments/;
const CREATE_COMMENT = /^POST .*\/repos\/o\/r\/issues\/\d+\/comments$/;
const READ_COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

interface Args {
	readonly stallClass?: string;
	readonly sha?: string;
}

const run = (
	script: ReadonlyArray<Scripted>,
	read: StdinRead = {_tag: "Text", text: BODY},
	args: Args = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runNote({
				pr: 4321,
				stallClass: args.stallClass ?? CLASS,
				sha: args.sha ?? HEAD,
				repo: null,
				json: false,
				env: ENV,
				stdin: Effect.succeed(read),
			}),
			fakeSeams(script).layer,
		),
	);

/** The happy path's reads, in order: the PR, a clear comment history, the write, the read-back. */
const clearBoard = (history: ExecResult = comments()): ReadonlyArray<Scripted> => [
	[PULL, reply(pull())],
	[LIST_COMMENTS, reply(history)],
	[CREATE_COMMENT, reply(createdComment(5155001122), 201)],
	[READ_COMMENT, reply(commentBody(POSTED))],
];

describe("runNote leaves the durable record", () => {
	it("posts a NEW comment carrying the key, and prints its url", async () => {
		const out = await run(clearBoard());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("noted\thttps://example.test/pull/4321#issuecomment-5155001122\n");
		expect(out.stderr.join("\n")).toContain(renderKey(KEY));
	});

	it("posts on a closed PR — a strand that resolved still deserves the record", async () => {
		const out = await run([
			[PULL, reply(pull({state: "closed"}))],
			[LIST_COMMENTS, reply(comments())],
			[CREATE_COMMENT, reply(createdComment(1), 201)],
			[READ_COMMENT, reply(commentBody(POSTED))],
		]);
		expect(out.code).toBe(0);
	});

	it("records at the head it was taken at, and says so, when the live head has moved", async () => {
		const posted = withKey(BODY, keyOf(4321, CLASS, OTHER_HEAD));
		const out = await run(
			[
				[PULL, reply(pull({head: HEAD}))],
				[LIST_COMMENTS, reply(comments())],
				[CREATE_COMMENT, reply(createdComment(2), 201)],
				[READ_COMMENT, reply(commentBody(posted))],
			],
			{_tag: "Text", text: BODY},
			{sha: OTHER_HEAD},
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain(`the live head is ${HEAD}`);
	});
});

describe("runNote suppresses a note this key already carries", () => {
	it("refuses on 14 with nothing posted when the exact key is on the PR", async () => {
		const out = await run([
			[PULL, reply(pull({comments: 1}))],
			[LIST_COMMENTS, reply(comments({id: 99, body: withKey("an earlier sweep", KEY)}))],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("already carries a note at key");
		expect(out.stderr.at(-1)).toContain("comment 99");
	});

	it("posts when the class changed — a re-classified strand is a new record", async () => {
		const other = withKey("an earlier sweep", keyOf(4321, "red", HEAD));
		const out = await run([
			[PULL, reply(pull({comments: 1}))],
			[LIST_COMMENTS, reply(comments({id: 99, body: other}))],
			[CREATE_COMMENT, reply(createdComment(3), 201)],
			[READ_COMMENT, reply(commentBody(POSTED))],
		]);
		expect(out.code).toBe(0);
	});

	it("posts when the head changed — a new commit makes the earlier note stale", async () => {
		const other = withKey("an earlier sweep", keyOf(4321, CLASS, OTHER_HEAD));
		const out = await run([
			[PULL, reply(pull({comments: 1}))],
			[LIST_COMMENTS, reply(comments({id: 99, body: other}))],
			[CREATE_COMMENT, reply(createdComment(4), 201)],
			[READ_COMMENT, reply(commentBody(POSTED))],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an unreadable comment list on 11 — UNKNOWN suppression, never an absent note", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[LIST_COMMENTS, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("suppression state is UNKNOWN");
	});

	it("refuses a truncated comment read on 13 rather than posting over it", async () => {
		const out = await run([
			[PULL, reply(pull({comments: 40}))],
			[LIST_COMMENTS, reply(comments({id: 1, body: "hi"}))],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});
});

describe("runNote refuses before it writes", () => {
	it("refuses a --class off the stall vocabulary on 10, before any read", async () => {
		const out = await run([], {_tag: "Text", text: BODY}, {stallClass: "stranded"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a stall class");
	});

	it("refuses an abbreviated --sha as a usage error — a key needs the whole sha", async () => {
		const out = await run([], {_tag: "Text", text: BODY}, {sha: "03135b91"});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("full 40-hex head");
	});

	it("refuses empty stdin on 3 — a silent classification leaves the strand invisible", async () => {
		const out = await run([[PULL, reply(pull())]], {_tag: "Text", text: "  \n"});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("refuses a body carrying a machine-local path on 5", async () => {
		const out = await run([[PULL, reply(pull())]], {
			_tag: "Text",
			text: "see ~/code/github.com/kamp-us/phoenix/x.ts\n",
		});
		expect(out.code).toBe(LEAKED_PATH);
	});

	it("refuses a bare @ path reference on 6 — not redactable", async () => {
		const out = await run([[PULL, reply(pull())]], {_tag: "Text", text: "@/tmp/note.md"});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("reports a failed create as UNKNOWN on 8, never as a landed note", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[LIST_COMMENTS, reply(comments())],
			[CREATE_COMMENT, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("UNKNOWN whether the note landed");
	});

	it("reports a mismatched read-back on 9", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[LIST_COMMENTS, reply(comments())],
			[CREATE_COMMENT, reply(createdComment(7), 201)],
			[READ_COMMENT, reply(commentBody("something else"))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
