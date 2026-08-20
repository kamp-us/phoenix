import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runNote} from "./note-verb.ts";

const ISSUE = /^GET .*\/repos\/o\/r\/issues\/4312$/;
const POST = /^POST .*\/repos\/o\/r\/issues\/4312\/comments$/;
const COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

const NOTE = "Also reproduces on the streaming path, not just the buffered one.";

const issue = (state: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body: "b",
		state,
		labels: [],
		html_url: "https://example.test/issues/4312",
	}),
});

const issueOpen = issue("open");
const issueClosed = issue("closed");

const comment = (body: string): HttpReply => ({status: 200, body: JSON.stringify({body})});

const posted: HttpReply = {
	status: 201,
	body: JSON.stringify({
		id: 5154891644,
		html_url: "https://example.test/issues/4312#issuecomment-5154891644",
	}),
};

const options = {
	issue: 4312,
	redact: false,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: NOTE}),
};

const happy: ReadonlyArray<Scripted> = [
	[COMMENT, comment(NOTE)],
	[ISSUE, issueOpen],
	[POST, posted],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runNote({...options, ...overrides}), fakeSeams(script).layer));

describe("runNote", () => {
	it("posts, reads back, and prints a bare tab-separated id and url", async () => {
		const out = await run(happy);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"5154891644\thttps://example.test/issues/4312#issuecomment-5154891644\n",
		);
	});

	it("emits the note record on STDOUT with --json", async () => {
		const out = await run(happy, {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			id: 5154891644,
			issue: 4312,
			redactions: [],
		});
	});

	it("validates nothing about the note's structure — a note is free prose", async () => {
		const out = await run(
			[
				[COMMENT, comment("one line, no headings")],
				[ISSUE, issueOpen],
				[POST, posted],
			],
			{stdin: Effect.succeed({_tag: "Text", text: "one line, no headings"} satisfies StdinRead)},
		);
		expect(out.code).toBe(0);
	});

	it("appends no footer — the note lands byte-for-byte as sent", async () => {
		const seams = fakeSeams(happy);
		await Effect.runPromise(Effect.provide(runNote(options), seams.layer));
		const post = seams.bodies[seams.requests.findIndex((c) => POST.test(c))] ?? "";
		expect(post).toBe(JSON.stringify({body: NOTE}));
		expect(post).not.toContain("Filed by an agent");
	});

	it("posts on a CLOSED issue but says so — never a surprise about where it landed", async () => {
		const out = await run([
			[COMMENT, comment(NOTE)],
			[ISSUE, issueClosed],
			[POST, posted],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("#4312 is closed.");
	});

	it("refuses a FAILED stdin read as UNKNOWN, never as an empty note", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"} satisfies StdinRead),
		});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("never empty");
	});

	it("refuses an empty-but-READ stdin on its own, different code", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({_tag: "Text", text: ""} satisfies StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it("refuses a bare @ path note on its own code", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({_tag: "Text", text: "@/tmp/note.md"} satisfies StdinRead),
			redact: true,
		});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path in the note", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "reproduced from /Users/someone/scratch/case.md",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr[0]).toBe("  line 1, absolute home root");
	});

	it("posts the masked note under --redact", async () => {
		const masked = "reproduced from /Users/<redacted>";
		const out = await run(
			[
				[COMMENT, comment(masked)],
				[ISSUE, issueOpen],
				[POST, posted],
			],
			{
				stdin: Effect.succeed({
					_tag: "Text",
					text: "reproduced from /Users/someone/scratch/case.md",
				} satisfies StdinRead),
				redact: true,
			},
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("redacted a machine-local path");
	});

	it("refuses an issue that does not exist", async () => {
		const out = await run([[ISSUE, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stderr.at(-1)).toBe("report note: o/r has no issue #4312.");
	});

	it("separates an UNREADABLE issue from an absent one, and posts nothing", async () => {
		const seams = fakeSeams([[ISSUE, {status: 502, body: "{}"}]]);
		const out = await Effect.runPromise(Effect.provide(runNote(options), seams.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(seams.requests.some((c) => POST.test(c))).toBe(false);
	});

	it("reports a failed post as UNKNOWN, with the re-read recovery", async () => {
		const out = await run([
			[ISSUE, issueOpen],
			[POST, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("may have landed");
	});

	it("refuses when the landed comment is not what was sent (#3173)", async () => {
		const out = await run([
			[COMMENT, comment("something else entirely")],
			[ISSUE, issueOpen],
			[POST, posted],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("needs fixing by hand");
	});

	it("refuses when the read-back itself fails — a post that is not verified is not finished", async () => {
		const out = await run([
			[COMMENT, {status: 502, body: "{}"}],
			[ISSUE, issueOpen],
			[POST, posted],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
