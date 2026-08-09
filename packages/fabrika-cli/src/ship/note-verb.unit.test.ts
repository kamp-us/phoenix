import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
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
import {ENV, pull} from "./fixtures.test-support.ts";
import {runNote} from "./note-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/4321\/comments/;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/5155001122$/;

const BODY = "ship: refused — head CI red at 9fe12ab0. Merge intent disarmed at site refuse.";
const URL = "https://github.com/o/r/pull/4321#issuecomment-5155001122";

const created = okOut(JSON.stringify({id: 5155001122, html_url: URL}));
const landed = (body: string): ExecResult => okOut(JSON.stringify({body}));

const options = {
	pr: 4321,
	repo: null,
	json: false,
	env: ENV,
	stdin: Effect.succeed({_tag: "Text", text: BODY} as StdinRead),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runNote({...options, ...overrides}), fakeShell(script).layer));

describe("runNote", () => {
	it("posts the note and proves it from a read-back", async () => {
		const out = await run([
			[PULL, pull()],
			[POST, created],
			[READBACK, landed(BODY)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`noted\t${URL}\n`);
	});

	it("posts on a merged PR — a refusal at any lifecycle stage still deserves a record", async () => {
		const out = await run([
			[PULL, pull({merged: true, state: "closed"})],
			[POST, created],
			[READBACK, landed(BODY)],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an empty body on 3 — a silent stop is the #1928 defect", async () => {
		const out = await run([[PULL, pull()]], {
			stdin: Effect.succeed({_tag: "Text", text: "\n\n"} as StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toContain("write the reason");
	});

	it("refuses a machine-local path on 5, naming the line and class", async () => {
		const out = await run([[PULL, pull()]], {
			stdin: Effect.succeed({_tag: "Text", text: "logs at /tmp/run/out.txt"} as StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.at(-1)).toContain("machine-local path at line 1 (temp root)");
	});

	it("refuses a bare @ reference on 6", async () => {
		const out = await run([[PULL, pull()]], {
			stdin: Effect.succeed({_tag: "Text", text: "@notes/stop.md"} as StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses on 8 when the create fails — UNKNOWN whether it landed", async () => {
		const out = await run([
			[PULL, pull()],
			[POST, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses on 9 when the landed body is not what was sent", async () => {
		const out = await run([
			[PULL, pull()],
			[POST, created],
			[READBACK, landed("something else entirely")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toBe(
			"ship note: the read-back does not match — inspect comment 5155001122.",
		);
	});

	it("accepts a read-back that differs only by trailing newlines", async () => {
		const out = await run([
			[PULL, pull()],
			[POST, created],
			[READBACK, landed(`${BODY}\n\n`)],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
