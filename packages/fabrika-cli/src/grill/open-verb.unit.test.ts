import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {cameFromSection} from "../wire/came-from.ts";
import {
	BARE_AT_PATH,
	BINDING_MALFORMED,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SESSION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {sessionPayload} from "./fixtures.test-support.ts";
import {type OpenSubject, openSubject, runOpen} from "./open-verb.ts";

const LABELS = /^gh api --paginate repos\/o\/r\/labels\?/;
const SEARCH = /^gh api --paginate repos\/o\/r\/issues\?state=open&labels=/;
const ISSUE = /^gh api repos\/o\/r\/issues\/\d+$/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues -f title=/;
const LABEL_WRITE = /^gh api --method POST repos\/o\/r\/issues\/\d+\/labels/;

const TOPIC = "sozluk moderation model";

const options = {
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

/** The subject a test names, refusing rather than silently opening on something else. */
const subjectOf = (topic: string | null, ticket: number | null): OpenSubject => {
	const subject = openSubject(topic, ticket);
	if (subject === null) throw new Error("this test named neither a topic nor a ticket");
	return subject;
};

const onTopic = {...options, subject: subjectOf(TOPIC, null)};

const created = okOut(JSON.stringify({number: 9412, html_url: "https://example.test/issues/9412"}));

/** One row of the search's `{number, title, body} | @json` output — the bytes the verb parses. */
const row = (number: number, title: string, body = ""): string =>
	JSON.stringify({number, title, body});

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: {readonly topic?: string | null; readonly ticket?: number | null} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runOpen({
				...options,
				subject: subjectOf(
					overrides.topic === undefined ? TOPIC : overrides.topic,
					overrides.ticket ?? null,
				),
			}),
			fakeShell(script).layer,
		),
	);

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
			ticket: null,
			created: true,
			url: "https://example.test/issues/9412",
		});
	});

	it("applies the label as part of the create, never as a caller's follow-up", async () => {
		const shell = fakeShell(script);
		await Effect.runPromise(Effect.provide(runOpen(onTopic), shell.layer));
		expect(shell.calls.some((call) => LABEL_WRITE.test(call))).toBe(true);
	});
});

describe("runOpen resumes an existing session", () => {
	it("answers created:false without writing anything", async () => {
		const shell = fakeShell([
			withLabel,
			[SEARCH, okOut(row(9412, TOPIC))],
			[ISSUE, okOut(sessionPayload(9412))],
		]);
		const out = await Effect.runPromise(Effect.provide(runOpen(onTopic), shell.layer));
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
			[SEARCH, okOut(row(9412, title))],
			[ISSUE, okOut(sessionPayload(9412))],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
	});

	it("does not match a title a human reads as related but that is not equal", async () => {
		const out = await run([
			withLabel,
			[SEARCH, okOut(row(9412, "sozluk moderation"))],
			[CREATE, created],
			[ISSUE, okOut(sessionPayload(9412, {labels: []}))],
			[LABEL_WRITE, okOut("{}")],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({created: true});
	});
});

describe("runOpen seats each refusal on its own code, with nothing on stdout", () => {
	const cases: ReadonlyArray<
		readonly [
			string,
			number,
			ReadonlyArray<readonly [RegExp, ExecResult]>,
			{readonly topic?: string | null; readonly ticket?: number | null},
		]
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
			[withLabel, [SEARCH, okOut(`${row(9412, TOPIC)}\n${row(9431, TOPIC)}`)]],
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
		await Effect.runPromise(Effect.provide(runOpen(onTopic), shell.layer));
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("keeps every refusal on a code of its own", () => {
		expect(new Set(cases.map(([, code]) => code)).size).toBeGreaterThan(4);
		expect(cases.map(([, code]) => code)).not.toContain(0);
	});
});

describe("runOpen binds a session to a wayfinding frontier ticket", () => {
	const TICKET = 5652;
	const TITLE = "does the extension seam belong to the plugin or the repo?";
	const TICKET_READ = /^gh api repos\/o\/r\/issues\/5652$/;
	const SESSION_READ = /^gh api repos\/o\/r\/issues\/9412$/;
	const ticketRead: readonly [RegExp, ExecResult] = [
		TICKET_READ,
		okOut(sessionPayload(TICKET, {labels: ["wayfinding:map"], title: TITLE})),
	];
	const bound = (number: number, title = TITLE): string =>
		row(number, title, `A grilling session.\n\n${cameFromSection(TICKET)}`);
	const onTicket = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) => fakeShell(script);
	const forTicket = (shell: ReturnType<typeof fakeShell>, topic: string | null = null) =>
		Effect.runPromise(
			Effect.provide(runOpen({...options, subject: subjectOf(topic, TICKET)}), shell.layer),
		);

	it("takes the title from the ticket and records the ticket on the body", async () => {
		const shell = onTicket([
			withLabel,
			ticketRead,
			[SEARCH, okOut("")],
			[CREATE, created],
			[SESSION_READ, okOut(sessionPayload(9412, {labels: [], title: TITLE}))],
			[LABEL_WRITE, okOut("{}")],
		]);
		const out = await forTicket(shell);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			session: 9412,
			topic: TITLE,
			ticket: TICKET,
			created: true,
		});
		const create = shell.calls.find((call) => CREATE.test(call)) ?? "";
		expect(create).toContain(`title=${TITLE}`);
		expect(create).toContain(cameFromSection(TICKET));
	});

	it("resumes the bound session on a second run, minting nothing", async () => {
		const shell = onTicket([
			withLabel,
			ticketRead,
			[SEARCH, okOut(bound(9412))],
			[SESSION_READ, okOut(sessionPayload(9412, {title: TITLE}))],
		]);
		const out = await forTicket(shell);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, ticket: TICKET, created: false});
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("resumes on the ticket even after both titles were edited apart", async () => {
		const renamed = "a title somebody renamed";
		const out = await forTicket(
			onTicket([
				withLabel,
				ticketRead,
				[SEARCH, okOut(bound(9412, renamed))],
				[SESSION_READ, okOut(sessionPayload(9412, {title: renamed}))],
			]),
			"a topic nobody would match on",
		);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
	});

	it("does not resume a same-titled session that is bound to nothing", async () => {
		const out = await forTicket(
			onTicket([
				withLabel,
				ticketRead,
				[SEARCH, okOut(row(9400, TITLE))],
				[CREATE, created],
				[SESSION_READ, okOut(sessionPayload(9412, {labels: [], title: TITLE}))],
				[LABEL_WRITE, okOut("{}")],
			]),
		);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: true});
	});

	it("refuses on 16 when two open sessions carry the same ticket", async () => {
		const out = await forTicket(
			onTicket([withLabel, ticketRead, [SEARCH, okOut(`${bound(9412)}\n${bound(9431)}`)]]),
		);
		expect(out.code).toBe(SESSION_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain(`ticket #${TICKET}`);
	});

	it.each([
		[NO_TARGET, "does not exist", "gh: Not Found (HTTP 404)"],
		[PRECONDITION_UNKNOWN, "could not be read", "gh: Bad gateway (HTTP 502)"],
	])("refuses on %i when the ticket %s, minting nothing", async (code, _case, reason) => {
		const shell = onTicket([withLabel, [TICKET_READ, errOut(reason)]]);
		const out = await forTicket(shell);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("refuses on 19 rather than minting a second session past a body it could not parse", async () => {
		const drifted = row(9400, TITLE, `A grilling session.\n\n### Came from\n\n#${TICKET}\n`);
		const shell = onTicket([withLabel, ticketRead, [SEARCH, okOut(drifted)]]);
		const out = await forTicket(shell);
		expect(out.code).toBe(BINDING_MALFORMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("#9400");
		expect(out.stderr.join("\n")).toContain("does not parse");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("reads a session bound to a different ticket as no match, not as a drift", async () => {
		const other = row(9400, TITLE, `A grilling session.\n\n${cameFromSection(4242)}`);
		const out = await forTicket(
			onTicket([
				withLabel,
				ticketRead,
				[SEARCH, okOut(other)],
				[CREATE, created],
				[SESSION_READ, okOut(sessionPayload(9412, {labels: [], title: TITLE}))],
				[LABEL_WRITE, okOut("{}")],
			]),
		);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: true});
	});
});

describe("openSubject makes 'neither a topic nor a ticket' unrepresentable", () => {
	it("answers null only when both are absent", () => {
		expect(openSubject(null, null)).toBeNull();
		expect(openSubject(TOPIC, null)).toEqual({_tag: "Topic", topic: TOPIC});
		expect(openSubject(null, 5652)).toEqual({_tag: "Ticket", ticket: 5652});
		expect(openSubject(TOPIC, 5652)).toEqual({_tag: "Bound", topic: TOPIC, ticket: 5652});
	});
});
