import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {compose} from "./amend.ts";
import {runAmend} from "./amend-verb.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";

const READ = /^GET .*\/repos\/o\/r\/issues\/4312$/;
const PATCH = /^PATCH .*\/repos\/o\/r\/issues\/4312$/;

const PRIOR = "## Summary\n\nThe editor loses focus after a save.";
const SECTION = "Reproduces on the streaming path too, not just the buffered one.";
const NOW = new Date("2026-08-21T03:31:36Z");
const URL = "https://example.test/issues/4312";

const issue = (body: string, state = "open"): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body,
		state,
		labels: [],
		html_url: URL,
		milestone: null,
	}),
});

const ACCEPTED: HttpReply = {status: 200, body: "{}"};

const options = {
	issue: 4312,
	redact: false,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: SECTION}),
	now: () => NOW,
};

const runScripted = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runAmend({...options, ...overrides}), fakeSeams(script).layer));

/** The body the PATCH carried, or `null` when the verb wrote nothing. */
const written = (seams: {
	readonly requests: ReadonlyArray<string>;
	readonly bodies: ReadonlyArray<string>;
}): string | null => {
	const at = seams.requests.findIndex((line) => PATCH.test(line));
	if (at < 0) return null;
	const sent: unknown = JSON.parse(seams.bodies[at] ?? "{}");
	const body = (sent as {readonly body?: unknown}).body;
	return typeof body === "string" ? body : null;
};

/**
 * Run against a prior body, echoing whatever the verb PATCHes back on the read-back.
 *
 * A live round-trip returns what was written, so a fake answering a fixed body would make every
 * read-back assertion a claim about the fixture instead of about the verb.
 */
const run = async (prior: string, overrides: Partial<typeof options> = {}) => {
	const probe = fakeSeams([
		[once(READ), issue(prior)],
		[PATCH, ACCEPTED],
	]);
	const first = await Effect.runPromise(
		Effect.provide(runAmend({...options, ...overrides}), probe.layer),
	);
	const patched = written(probe);
	if (patched === null) return {outcome: first, body: null};
	const echoing = fakeSeams([
		[once(READ), issue(prior)],
		[PATCH, ACCEPTED],
		[READ, issue(patched)],
	]);
	const outcome = await Effect.runPromise(
		Effect.provide(runAmend({...options, ...overrides}), echoing.layer),
	);
	return {outcome, body: patched};
};

describe("runAmend", () => {
	it("appends without touching the prior body, and prints a tab-separated issue and url", async () => {
		const {outcome, body} = await run(PRIOR);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`4312\t${URL}\n`);
		expect(body).toBe(compose(PRIOR, SECTION, NOW).body);
		expect(body?.startsWith(PRIOR)).toBe(true);
	});

	it("emits the equivalent object on STDOUT with --json", async () => {
		const {outcome} = await run(PRIOR, {json: true});
		expect(JSON.parse(outcome.stdout)).toMatchObject({issue: 4312, url: URL, redactions: []});
	});

	it("amends an empty body with the amendment alone", async () => {
		const {outcome, body} = await run("");
		expect(outcome.code).toBe(0);
		expect(body).toBe(
			"## Amendment — 2026-08-21\n\nReproduces on the streaming path too, not just the buffered one.\n",
		);
	});

	it("amends a CLOSED issue but says so — never a surprise about where it landed", async () => {
		const script: ReadonlyArray<Scripted> = [
			[once(READ), issue(PRIOR, "closed")],
			[PATCH, ACCEPTED],
			[READ, issue(compose(PRIOR, SECTION, NOW).body, "closed")],
		];
		const outcome = await runScripted(script);
		expect(outcome.code).toBe(0);
		expect(outcome.stderr.join("\n")).toContain("#4312 is closed.");
	});

	it("refuses a FAILED stdin read as UNKNOWN, never as an empty amendment", async () => {
		const outcome = await runScripted([[READ, issue(PRIOR)]], {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"} satisfies StdinRead),
		});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toContain("never empty");
	});

	it("refuses an empty-but-READ stdin on its own, different code, and writes nothing", async () => {
		const seams = fakeSeams([[READ, issue(PRIOR)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runAmend({...options, stdin: Effect.succeed({_tag: "Text", text: ""})}),
				seams.layer,
			),
		);
		expect(outcome.code).toBe(EMPTY_STDIN);
		expect(seams.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses a bare @ path on its own code even under --redact, and writes nothing", async () => {
		const seams = fakeSeams([[READ, issue(PRIOR)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runAmend({
					...options,
					redact: true,
					stdin: Effect.succeed({_tag: "Text", text: "@/tmp/correction.md"}),
				}),
				seams.layer,
			),
		);
		expect(outcome.code).toBe(BARE_AT_PATH);
		expect(seams.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses a machine-local path in the appended section", async () => {
		const outcome = await runScripted([[READ, issue(PRIOR)]], {
			stdin: Effect.succeed({_tag: "Text", text: "reproduced from /Users/someone/case.md"}),
		});
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stderr[0]).toBe("  line 1, absolute home root");
	});

	it("appends the masked section under --redact", async () => {
		const {outcome, body} = await run(PRIOR, {
			redact: true,
			stdin: Effect.succeed({_tag: "Text", text: "reproduced from /Users/someone/case.md"}),
		});
		expect(outcome.code).toBe(0);
		expect(body).toContain("reproduced from /Users/<redacted>");
		expect(outcome.stderr.join("\n")).toContain("redacted a machine-local path");
	});

	it("scans the appended section only — a path in the prior body is preserved, not rewritten", async () => {
		const leaky = `${PRIOR}\n\nfirst seen at /Users/someone/case.md`;
		const {outcome, body} = await run(leaky);
		expect(outcome.code).toBe(0);
		expect(body).toContain("/Users/someone/case.md");
	});

	it("refuses an issue that does not exist", async () => {
		const outcome = await runScripted([[READ, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(outcome.code).toBe(NO_TARGET);
		expect(outcome.stderr.at(-1)).toBe("report amend: o/r has no issue #4312.");
	});

	it("separates an UNREADABLE issue from an absent one, and writes nothing", async () => {
		const seams = fakeSeams([[READ, {status: 502, body: "{}"}]]);
		const outcome = await Effect.runPromise(Effect.provide(runAmend(options), seams.layer));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(seams.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("reports a failed PATCH as UNKNOWN, with the re-read recovery", async () => {
		const outcome = await runScripted([
			[READ, issue(PRIOR)],
			[PATCH, {status: 500, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("may have landed");
	});

	it("refuses when the appended section is absent from the landed body", async () => {
		const outcome = await runScripted([
			[once(READ), issue(PRIOR)],
			[PATCH, ACCEPTED],
			[READ, issue(PRIOR)],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toContain("appended amendment is not in the landed body");
	});

	it("refuses when the prior body did not survive — a replacement wearing an append's shape", async () => {
		const outcome = await runScripted([
			[once(READ), issue(PRIOR)],
			[PATCH, ACCEPTED],
			[READ, issue(`something else entirely\n\n${compose(PRIOR, SECTION, NOW).appended}`)],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toContain("prior body did not survive");
	});

	it("refuses when the read-back itself fails — the write's own echo is not evidence", async () => {
		const outcome = await runScripted([
			[once(READ), issue(PRIOR)],
			[PATCH, ACCEPTED],
			[READ, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
