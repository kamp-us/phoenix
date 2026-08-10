import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	BARE_AT_PATH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SESSION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {sessionPayload} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";

const LABELS = /^gh api --paginate repos\/o\/r\/labels\?/;
const SEARCH = /^gh api --paginate repos\/o\/r\/issues\?state=open&labels=/;
const ISSUE = /^gh api repos\/o\/r\/issues\/\d+$/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues -f title=/;
const LABEL_WRITE = /^gh api --method POST repos\/o\/r\/issues\/\d+\/labels/;

const TOPIC = "sozluk moderation model";

const options = {
	topic: TOPIC,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const created = okOut(JSON.stringify({number: 9412, html_url: "https://example.test/issues/9412"}));

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runOpen({...options, ...overrides}), fakeShell(script).layer));

const withLabel: readonly [RegExp, ExecResult] = [LABELS, okOut("grilling:session\nbug")];

describe("runOpen mints a session when none matches", () => {
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		withLabel,
		[SEARCH, okOut("")],
		[CREATE, created],
		[ISSUE, okOut(sessionPayload(9412, {labels: []}))],
		[LABEL_WRITE, okOut("{}")],
	];

	it("answers with created:true and the minted number", async () => {
		const out = await run(script);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			session: 9412,
			topic: TOPIC,
			created: true,
			url: "https://example.test/issues/9412",
		});
	});

	it("applies the label as part of the create, never as a caller's follow-up", async () => {
		const shell = fakeShell(script);
		await Effect.runPromise(Effect.provide(runOpen(options), shell.layer));
		expect(shell.calls.some((call) => LABEL_WRITE.test(call))).toBe(true);
	});
});

describe("runOpen resumes an existing session", () => {
	it("answers created:false without writing anything", async () => {
		const shell = fakeShell([
			withLabel,
			[SEARCH, okOut(`9412\t${TOPIC}`)],
			[ISSUE, okOut(sessionPayload(9412))],
		]);
		const out = await Effect.runPromise(Effect.provide(runOpen(options), shell.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it.each([
		["case", "SOZLUK Moderation MODEL"],
		["surrounding whitespace", `  ${TOPIC}  `],
		["an internal whitespace run", "sozluk   moderation\tmodel"],
	])("matches a title differing only in %s", async (_case, title) => {
		const out = await run([
			withLabel,
			[SEARCH, okOut(`9412\t${title}`)],
			[ISSUE, okOut(sessionPayload(9412))],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
	});

	it("does not match a title a human reads as related but that is not equal", async () => {
		const out = await run([
			withLabel,
			[SEARCH, okOut("9412\tsozluk moderation")],
			[CREATE, created],
			[ISSUE, okOut(sessionPayload(9412, {labels: []}))],
			[LABEL_WRITE, okOut("{}")],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({created: true});
	});
});

describe("runOpen seats each refusal on its own code, with nothing on stdout", () => {
	const cases: ReadonlyArray<
		readonly [string, number, ReadonlyArray<readonly [RegExp, ExecResult]>, Partial<typeof options>]
	> = [
		[
			"a machine-local path in the topic",
			LEAKED_PATH,
			[withLabel],
			{topic: "why /Users/someone/notes.md is stale"},
		],
		["a bare @ path topic", BARE_AT_PATH, [withLabel], {topic: "@/Users/someone/notes.md"}],
		["the session label not existing", NO_TARGET, [[LABELS, okOut("bug\nchore")]], {}],
		[
			"a label read that failed",
			PRECONDITION_UNKNOWN,
			[[LABELS, errOut("gh: Bad gateway (HTTP 502)")]],
			{},
		],
		[
			"a search that could not complete",
			PRECONDITION_UNKNOWN,
			[withLabel, [SEARCH, errOut("gh: Bad gateway (HTTP 502)")]],
			{},
		],
		[
			"more than one matching session",
			SESSION_AMBIGUOUS,
			[withLabel, [SEARCH, okOut(`9412\t${TOPIC}\n9431\t${TOPIC}`)]],
			{},
		],
		[
			"a create that failed",
			WRITE_UNKNOWN,
			[withLabel, [SEARCH, okOut("")], [CREATE, errOut("gh: Bad gateway (HTTP 502)")]],
			{},
		],
		[
			"a read-back whose title differs",
			READBACK_MISMATCH,
			[
				withLabel,
				[SEARCH, okOut("")],
				[CREATE, created],
				[ISSUE, okOut(sessionPayload(9412, {labels: [], title: "something else entirely"}))],
			],
			{},
		],
		[
			"a label write that failed after the create landed",
			WRITE_UNKNOWN,
			[
				withLabel,
				[SEARCH, okOut("")],
				[CREATE, created],
				[ISSUE, okOut(sessionPayload(9412, {labels: []}))],
				[LABEL_WRITE, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{},
		],
	];

	it.each(cases)("refuses %s on %i", async (_case, code, script, overrides) => {
		const out = await run(script, overrides);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("grill open:");
	});

	it("names the orphaned issue when the label write is the half that failed", async () => {
		const out = await run([
			withLabel,
			[SEARCH, okOut("")],
			[CREATE, created],
			[ISSUE, okOut(sessionPayload(9412, {labels: []}))],
			[LABEL_WRITE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.stderr.join("\n")).toContain("#9412");
		expect(out.stderr.join("\n")).toContain("unlabelled and unfindable");
	});

	it("mints nothing when the search could not complete", async () => {
		const shell = fakeShell([withLabel, [once(SEARCH), errOut("gh: Bad gateway (HTTP 502)")]]);
		await Effect.runPromise(Effect.provide(runOpen(options), shell.layer));
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("keeps every refusal on a code of its own", () => {
		expect(new Set(cases.map(([, code]) => code)).size).toBeGreaterThan(4);
		expect(cases.map(([, code]) => code)).not.toContain(0);
	});
});
