import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLASSIFIED,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {composeBody, REQUIRED_SECTIONS, renderFooter} from "./compose.ts";
import {runFile} from "./file-verb.ts";

const READBACK = /^GET .*\/repos\/o\/r\/issues\/\d+$/;
const CREATE = /^POST .*\/repos\/o\/r\/issues$/;
const LABELS = /repos\/o\/r\/labels/;
const BRANCH = /git rev-parse/;

const NOW = new Date("2026-08-01T14:22:07.000Z");

const sections = REQUIRED_SECTIONS.map((h) =>
	h === "## Suggested next step (non-binding)" ? `${h}\n` : `${h}\ncontent for ${h}`,
).join("\n\n");

/** What the verb composes for these inputs: no session, no model, detached branch, fixed clock. */
const composed = composeBody(
	sections,
	renderFooter({session: null, model: null, branch: null, timestamp: "2026-08-01T14:22:07Z"}),
);

const created: HttpReply = {
	status: 201,
	body: JSON.stringify({number: 4732, html_url: "https://example.test/issues/4732"}),
};

const landed = (
	body: string,
	labels: ReadonlyArray<string> = ["status:needs-triage"],
): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4732,
		title: "t",
		body,
		state: "open",
		labels: labels.map((name) => ({name})),
		html_url: "https://example.test/issues/4732",
	}),
});

const options = {
	title: "Retry helper in the http worker swallows the abort reason",
	label: "status:needs-triage",
	redact: false,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: sections}),
	now: () => NOW,
};

const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const labelsOk = [LABELS, labelSet("status:needs-triage", "type:bug", "p0")] as const;
const branchDetached = [BRANCH, errOut("detached")] as const;

const happy: ReadonlyArray<Scripted> = [
	[READBACK, landed(composed)],
	[CREATE, created],
	labelsOk,
	branchDetached,
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runFile({...options, ...overrides}), fakeSeams(script).layer));

describe("runFile", () => {
	it("files, reads back, and prints a bare tab-separated number and url", async () => {
		const out = await run(happy);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("4732\thttps://example.test/issues/4732\n");
	});

	it("emits the full filing record on STDOUT with --json", async () => {
		const out = await run(happy, {json: true});
		const payload = JSON.parse(out.stdout);
		expect(payload).toMatchObject({
			number: 4732,
			url: "https://example.test/issues/4732",
			label: "status:needs-triage",
			// ADR 0308: `redactions` is an evidence-array collapsed to a per-class tally; empty means
			// the empty object, exactly as an empty array meant "nothing was masked".
			redactions: {},
		});
		expect(payload.bodyBytes).toBeGreaterThan(0);
	});

	it("appends the footer itself, with the never-dropped marker", async () => {
		const seams = fakeSeams(happy);
		await Effect.runPromise(Effect.provide(runFile(options), seams.layer));
		const create = seams.bodies[seams.requests.findIndex((c) => CREATE.test(c))] ?? "";
		expect(create).toContain("Filed by an agent");
		expect(create).toContain("2026-08-01T14:22:07Z");
	});

	it("refuses a FAILED stdin read as UNKNOWN, never as an empty body (#3924)", async () => {
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
		expect(out.stderr.at(-1)).toContain("0 bytes");
	});

	it("treats a TTY with nothing piped in as a bodyless filing, not a broken verb", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({_tag: "NoStdin", reason: "fd 0 is a TTY"} satisfies StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it("refuses a bare @ path body on its own code — --redact must not apply", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({_tag: "Text", text: "@/tmp/body.md\n"} satisfies StdinRead),
			redact: true,
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.stderr.at(-1)).toContain("--redact does not apply");
	});

	it("names the one section that is wrong", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({
				_tag: "Text",
				text: sections.replace("## Pointers\ncontent for ## Pointers", ""),
			} satisfies StdinRead),
		});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe('report file: section "## Pointers" is missing.');
	});

	it("refuses a machine-local path with one indented hit per line", async () => {
		const out = await run(happy, {
			stdin: Effect.succeed({
				_tag: "Text",
				text: sections.replace("content for ## Pointers", "/tmp/session/body.md"),
			} satisfies StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr[0]).toMatch(/^ {2}line \d+, temp root$/);
	});

	it("files the masked body under --redact, and says what it masked", async () => {
		const text = sections.replace("content for ## Pointers", "/tmp/session/body.md");
		const masked = composeBody(
			text.replace("/tmp/session/body.md", "/tmp/<redacted>"),
			renderFooter({session: null, model: null, branch: null, timestamp: "2026-08-01T14:22:07Z"}),
		);
		const out = await run(
			[[READBACK, landed(masked)], [CREATE, created], labelsOk, branchDetached],
			{stdin: Effect.succeed({_tag: "Text", text} satisfies StdinRead), redact: true},
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("redacted a machine-local path");
	});

	/**
	 * ADR 0308: the answer channel carries one count per leak class — each hit's `line <n>, <class>`
	 * note is already on the notes channel, so per-row `{line, class}` objects there were a second
	 * copy of a diagnostic.
	 */
	it("collapses --json redactions to a per-class tally, never rows", async () => {
		const text = sections
			.replace("content for ## Pointers", "/tmp/session/body.md and /Users/someone/case.md")
			.concat("\nand /private/var/folders/zz/log.txt once more");
		const masked = composeBody(
			text
				.replace("/tmp/session/body.md", "/tmp/<redacted>")
				.replace("/Users/someone/case.md", "/Users/<redacted>")
				.replace("/private/var/folders/zz/log.txt", "/private/var/<redacted>"),
			renderFooter({session: null, model: null, branch: null, timestamp: "2026-08-01T14:22:07Z"}),
		);
		const out = await run(
			[[READBACK, landed(masked)], [CREATE, created], labelsOk, branchDetached],
			{stdin: Effect.succeed({_tag: "Text", text} satisfies StdinRead), redact: true, json: true},
		);
		expect(out.code).toBe(0);
		const payload = JSON.parse(out.stdout);
		expect(payload.redactions).toEqual({"absolute home root": 1, "temp root": 2});
		expect(out.stdout).not.toContain('"line"');
	});

	it("refuses a label that does not exist in the repo", async () => {
		const out = await run(happy, {label: "status:needs-triageee"});
		expect(out.code).toBe(NO_TARGET);
		expect(out.stderr.at(-1)).toContain("outside the intake queue");
	});

	it("refuses an UNREADABLE label set as UNKNOWN, and files nothing", async () => {
		const seams = fakeSeams([
			[READBACK, landed(composed)],
			[CREATE, created],
			[LABELS, {status: 502, body: "{}"}],
			branchDetached,
		]);
		const out = await Effect.runPromise(Effect.provide(runFile(options), seams.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(seams.requests.some((c) => CREATE.test(c))).toBe(false);
	});

	it("refuses a --label that classifies", async () => {
		const out = await run(happy, {label: "type:bug"});
		expect(out.code).toBe(CLASSIFIED);
		expect(out.stderr.at(-1)).toContain("Triage classifies; this verb files.");
	});

	it("refuses a title that leads with a classification prefix", async () => {
		const out = await run(happy, {title: "BUG: retry helper swallows the abort reason"});
		expect(out.code).toBe(CLASSIFIED);
		expect(out.stderr.at(-1)).toContain('"BUG:"');
	});

	it("reports a failed create as UNKNOWN, with the re-run-dedup recovery", async () => {
		const out = await run([
			[READBACK, landed(composed)],
			[CREATE, {status: 503, body: "{}"}],
			labelsOk,
			branchDetached,
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("Re-run `report dedup`");
	});

	it("refuses when the read-back carries a label the verb did not apply", async () => {
		const out = await run([
			[READBACK, landed(composed, ["status:needs-triage", "type:bug"])],
			[CREATE, created],
			labelsOk,
			branchDetached,
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("needs fixing by hand");
	});

	it("refuses when the landed body is not what was composed (#3173)", async () => {
		const out = await run([
			[READBACK, landed(composed.replace("content for ## Summary", "something else"))],
			[CREATE, created],
			labelsOk,
			branchDetached,
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("tolerates the round-trip's line-ending and trailing-whitespace normalisation", async () => {
		const out = await run([
			[READBACK, landed(`${composed.replace(/\n/g, "\r\n")}   \r\n`)],
			[CREATE, created],
			labelsOk,
			branchDetached,
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an empty --title", async () => {
		const out = await run(happy, {title: "  "});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("untitled");
	});
});
