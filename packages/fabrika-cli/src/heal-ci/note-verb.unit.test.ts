import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell} from "../fakes.test-support.ts";
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
import {
	CREATE_COMMENT,
	commentBody,
	createdComment,
	ENV,
	PULL,
	pull,
	READ_COMMENT,
} from "./fixtures.test-support.ts";
import {runNote} from "./note-verb.ts";

const BODY = "heal-ci: ROUTED — PR #4321 → ship\n\nGate satisfied, CI green, nobody holding it.\n";

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	read: StdinRead = {_tag: "Text", text: BODY},
) =>
	Effect.runPromise(
		Effect.provide(
			runNote({pr: 4321, repo: null, json: false, env: ENV, stdin: Effect.succeed(read)}),
			fakeShell(script).layer,
		),
	);

describe("runNote leaves the durable record", () => {
	it("posts a NEW comment and prints its url", async () => {
		const out = await run([
			[PULL, pull()],
			[CREATE_COMMENT, createdComment(5155001122)],
			[READ_COMMENT, commentBody(BODY)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("noted\thttps://example.test/pull/4321#issuecomment-5155001122\n");
	});

	it("posts on a closed PR — a strand that resolved still deserves the record", async () => {
		const out = await run([
			[PULL, pull({state: "closed"})],
			[CREATE_COMMENT, createdComment(1)],
			[READ_COMMENT, commentBody(BODY)],
		]);
		expect(out.code).toBe(0);
	});
});

describe("runNote refuses before it writes", () => {
	it("refuses empty stdin on 3 — a silent classification leaves the strand invisible", async () => {
		const out = await run([[PULL, pull()]], {_tag: "Text", text: "  \n"});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("refuses a body carrying a machine-local path on 5", async () => {
		const out = await run([[PULL, pull()]], {
			_tag: "Text",
			text: "see ~/code/github.com/kamp-us/phoenix/x.ts\n",
		});
		expect(out.code).toBe(LEAKED_PATH);
	});

	it("refuses a bare @ path reference on 6 — not redactable", async () => {
		const out = await run([[PULL, pull()]], {_tag: "Text", text: "@/tmp/note.md"});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("reports a failed create as UNKNOWN on 8, never as a landed note", async () => {
		const out = await run([
			[PULL, pull()],
			[CREATE_COMMENT, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("UNKNOWN whether the note landed");
	});

	it("reports a mismatched read-back on 9", async () => {
		const out = await run([
			[PULL, pull()],
			[CREATE_COMMENT, createdComment(7)],
			[READ_COMMENT, commentBody("something else")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
