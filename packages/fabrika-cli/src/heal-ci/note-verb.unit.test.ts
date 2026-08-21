import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {commentBody, createdComment, ENV, pull} from "./fixtures.test-support.ts";
import {runNote} from "./note-verb.ts";

const BODY = "heal-ci: ROUTED — PR #4321 → ship\n\nGate satisfied, CI green, nobody holding it.\n";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const CREATE_COMMENT = /^POST .*\/repos\/o\/r\/issues\/\d+\/comments$/;
const READ_COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const run = (script: ReadonlyArray<Scripted>, read: StdinRead = {_tag: "Text", text: BODY}) =>
	Effect.runPromise(
		Effect.provide(
			runNote({pr: 4321, repo: null, json: false, env: ENV, stdin: Effect.succeed(read)}),
			fakeSeams(script).layer,
		),
	);

describe("runNote leaves the durable record", () => {
	it("posts a NEW comment and prints its url", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CREATE_COMMENT, reply(createdComment(5155001122), 201)],
			[READ_COMMENT, reply(commentBody(BODY))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("noted\thttps://example.test/pull/4321#issuecomment-5155001122\n");
	});

	it("posts on a closed PR — a strand that resolved still deserves the record", async () => {
		const out = await run([
			[PULL, reply(pull({state: "closed"}))],
			[CREATE_COMMENT, reply(createdComment(1), 201)],
			[READ_COMMENT, reply(commentBody(BODY))],
		]);
		expect(out.code).toBe(0);
	});
});

describe("runNote refuses before it writes", () => {
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
			[CREATE_COMMENT, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("UNKNOWN whether the note landed");
	});

	it("reports a mismatched read-back on 9", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CREATE_COMMENT, reply(createdComment(7), 201)],
			[READ_COMMENT, reply(commentBody("something else"))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
