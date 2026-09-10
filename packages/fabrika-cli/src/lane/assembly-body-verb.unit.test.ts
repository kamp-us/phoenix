/** `lane assembly-body` — the relay, the refusal that empties the pipe, and the stdin seats. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {FAILED} from "../verb.ts";
import {runAssemblyBody} from "./assembly-body-verb.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH, TAIL_NOT_CLOSING} from "./codes.ts";

const run = (read: StdinRead) =>
	Effect.runPromise(runAssemblyBody({epic: 4300, stdin: Effect.succeed(read)}));

const piped = (text: string): StdinRead => ({_tag: "Text", text});

const BODY = "## About this epic\n\nFixes #4301\nFixes #4300\n\n## Deviations\n\nNone.\n";

describe("lane assembly-body", () => {
	it("relays a body that closes the epic unchanged", async () => {
		const out = await run(piped(BODY));

		expect(out.code).toBe(0);
		expect(out.stdout).toBe(BODY);
	});

	// The one departure from "the same bytes out", and it is `answer`'s rather than this verb's:
	// a body with no final newline gets one. Pinned so the shipped text describing the relay stays
	// checkable against the code, which claimed byte-for-byte and was not quite that.
	it("terminates a relayed body that lacks a final newline", async () => {
		const out = await run(piped("Fixes #4300"));

		expect(out.code).toBe(0);
		expect(out.stdout).toBe("Fixes #4300\n");
	});

	it("refuses a body that only says `Part of` the epic, and prints nothing to open with", async () => {
		const out = await run(piped("Part of #4300\n\n## Deviations\n\nNone.\n"));

		expect(out.code).toBe(TAIL_NOT_CLOSING);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("no closing keyword aimed at #4300");
	});

	it("refuses a body that closes only the landed children", async () => {
		const out = await run(piped("Fixes #4301\nFixes #4302\n"));

		expect(out.code).toBe(TAIL_NOT_CLOSING);
		expect(out.stderr.join(" ")).toContain("#4301, #4302");
	});

	it("refuses a body carrying a machine-local path before it judges the link", async () => {
		const out = await run(piped(`${BODY}\nSee /Users/someone/code/checkout/notes.md\n`));

		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
	});

	it("refuses a body that is a bare @ path reference", async () => {
		const out = await run(piped("@notes/tail-body.md\n"));

		expect(out.code).toBe(BARE_AT_PATH);
	});

	// An unread pipe and an empty one must not collapse: the second is a proven answer about the
	// body, and the first is no answer at all.
	it("seats a read-but-empty pipe apart from one that could not be read", async () => {
		expect((await run(piped("   \n"))).code).toBe(EMPTY_STDIN);
		expect((await run({_tag: "Failed", reason: "EIO"})).code).toBe(FAILED);
	});
});
