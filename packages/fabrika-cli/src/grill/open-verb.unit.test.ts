import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
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

const LABELS = /^GET .*\/repos\/o\/r\/labels\?/;
const SEARCH = /^GET .*\/repos\/o\/r\/issues\?state=open&labels=/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/\d+$/;
const CREATE = /^POST .*\/repos\/o\/r\/issues$/;
const LABEL_WRITE = /^POST .*\/repos\/o\/r\/issues\/\d+\/labels$/;

const served = (body: string, status = 200): HttpReply => ({status, body});
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

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

const created = served(
	JSON.stringify({number: 9412, html_url: "https://example.test/issues/9412"}),
	201,
);

/** One entry of the label-scoped issue list — the payload the verb parses. */
const row = (number: number, title: string, body = ""): Record<string, unknown> => ({
	number,
	title,
	body,
});

/** The list read's served page. */
const listing = (...rows: ReadonlyArray<Record<string, unknown>>): HttpReply =>
	served(JSON.stringify(rows));

const labelled = (...names: ReadonlyArray<string>): HttpReply =>
	served(JSON.stringify(names.map((name) => ({name}))));

const run = (
	script: ReadonlyArray<Scripted>,
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
			fakeSeams(script).layer,
		),
	);

const withLabel: Scripted = [LABELS, labelled("grilling:session", "bug")];

describe("runOpen mints a session when none matches", () => {
	const script: ReadonlyArray<Scripted> = [
		withLabel,
		[SEARCH, listing()],
		[CREATE, created],
		[ISSUE, served(sessionPayload(9412, {labels: []}))],
		[LABEL_WRITE, served("{}")],
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
		const seams = fakeSeams(script);
		await Effect.runPromise(Effect.provide(runOpen(onTopic), seams.layer));
		expect(seams.requests.some((request) => LABEL_WRITE.test(request))).toBe(true);
	});
});

describe("runOpen resumes an existing session", () => {
	it("answers created:false without writing anything", async () => {
		const seams = fakeSeams([
			withLabel,
			[SEARCH, listing(row(9412, TOPIC))],
			[ISSUE, served(sessionPayload(9412))],
		]);
		const out = await Effect.runPromise(Effect.provide(runOpen(onTopic), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
		expect(seams.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it.each([
		["case", "SOZLUK Moderation MODEL"],
		["surrounding whitespace", `  ${TOPIC}  `],
		["an internal whitespace run", "sozluk   moderation\tmodel"],
	])("matches a title differing only in %s", async (_case, title) => {
		const out = await run([
			withLabel,
			[SEARCH, listing(row(9412, title))],
			[ISSUE, served(sessionPayload(9412))],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: false});
	});

	it("does not match a title a human reads as related but that is not equal", async () => {
		const out = await run([
			withLabel,
			[SEARCH, listing(row(9412, "sozluk moderation"))],
			[CREATE, created],
			[ISSUE, served(sessionPayload(9412, {labels: []}))],
			[LABEL_WRITE, served("{}")],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({created: true});
	});
});

describe("runOpen seats each refusal on its own code, with nothing on stdout", () => {
	const cases: ReadonlyArray<
		readonly [
			string,
			number,
			ReadonlyArray<Scripted>,
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
		["the session label not existing", NO_TARGET, [[LABELS, labelled("bug", "chore")]], {}],
		["a label read that failed", PRECONDITION_UNKNOWN, [[LABELS, GATEWAY]], {}],
		["a search that could not complete", PRECONDITION_UNKNOWN, [withLabel, [SEARCH, GATEWAY]], {}],
		[
			"more than one matching session",
			SESSION_AMBIGUOUS,
			[withLabel, [SEARCH, listing(row(9412, TOPIC), row(9431, TOPIC))]],
			{},
		],
		[
			"a create that failed",
			WRITE_UNKNOWN,
			[withLabel, [SEARCH, listing()], [CREATE, GATEWAY]],
			{},
		],
		[
			"a read-back whose title differs",
			READBACK_MISMATCH,
			[
				withLabel,
				[SEARCH, listing()],
				[CREATE, created],
				[ISSUE, served(sessionPayload(9412, {labels: [], title: "something else entirely"}))],
			],
			{},
		],
		[
			"a label write that failed after the create landed",
			WRITE_UNKNOWN,
			[
				withLabel,
				[SEARCH, listing()],
				[CREATE, created],
				[ISSUE, served(sessionPayload(9412, {labels: []}))],
				[LABEL_WRITE, GATEWAY],
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
			[SEARCH, listing()],
			[CREATE, created],
			[ISSUE, served(sessionPayload(9412, {labels: []}))],
			[LABEL_WRITE, GATEWAY],
		]);
		expect(out.stderr.join("\n")).toContain("#9412");
		expect(out.stderr.join("\n")).toContain("unlabelled and unfindable");
	});

	it("mints nothing when the search could not complete", async () => {
		const seams = fakeSeams([withLabel, [once(SEARCH), GATEWAY]]);
		await Effect.runPromise(Effect.provide(runOpen(onTopic), seams.layer));
		expect(seams.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("keeps every refusal on a code of its own", () => {
		expect(new Set(cases.map(([, code]) => code)).size).toBeGreaterThan(4);
		expect(cases.map(([, code]) => code)).not.toContain(0);
	});
});

describe("runOpen binds a session to a wayfinding frontier ticket", () => {
	const TICKET = 5652;
	const TITLE = "does the extension seam belong to the plugin or the repo?";
	const TICKET_READ = /^GET .*\/repos\/o\/r\/issues\/5652$/;
	const SESSION_READ = /^GET .*\/repos\/o\/r\/issues\/9412$/;
	const ticketRead: Scripted = [
		TICKET_READ,
		served(sessionPayload(TICKET, {labels: ["wayfinding:map"], title: TITLE})),
	];
	const bound = (number: number, title = TITLE): Record<string, unknown> =>
		row(number, title, `A grilling session.\n\n${cameFromSection(TICKET)}`);
	const onTicket = (script: ReadonlyArray<Scripted>) => fakeSeams(script);
	const forTicket = (seams: ReturnType<typeof fakeSeams>, topic: string | null = null) =>
		Effect.runPromise(
			Effect.provide(runOpen({...options, subject: subjectOf(topic, TICKET)}), seams.layer),
		);

	it("takes the title from the ticket and records the ticket on the body", async () => {
		const seams = onTicket([
			withLabel,
			ticketRead,
			[SEARCH, listing()],
			[CREATE, created],
			[SESSION_READ, served(sessionPayload(9412, {labels: [], title: TITLE}))],
			[LABEL_WRITE, served("{}")],
		]);
		const out = await forTicket(seams);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			session: 9412,
			topic: TITLE,
			ticket: TICKET,
			created: true,
		});
		const at = seams.requests.findIndex((request) => CREATE.test(request));
		const create = JSON.parse(seams.bodies[at] ?? "{}") as Record<string, string>;
		expect(create.title).toBe(TITLE);
		expect(create.body).toContain(cameFromSection(TICKET));
	});

	it("resumes the bound session on a second run, minting nothing", async () => {
		const seams = onTicket([
			withLabel,
			ticketRead,
			[SEARCH, listing(bound(9412))],
			[SESSION_READ, served(sessionPayload(9412, {title: TITLE}))],
		]);
		const out = await forTicket(seams);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, ticket: TICKET, created: false});
		expect(seams.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("resumes on the ticket even after both titles were edited apart", async () => {
		const renamed = "a title somebody renamed";
		const out = await forTicket(
			onTicket([
				withLabel,
				ticketRead,
				[SEARCH, listing(bound(9412, renamed))],
				[SESSION_READ, served(sessionPayload(9412, {title: renamed}))],
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
				[SEARCH, listing(row(9400, TITLE))],
				[CREATE, created],
				[SESSION_READ, served(sessionPayload(9412, {labels: [], title: TITLE}))],
				[LABEL_WRITE, served("{}")],
			]),
		);
		expect(JSON.parse(out.stdout)).toMatchObject({session: 9412, created: true});
	});

	it("refuses on 16 when two open sessions carry the same ticket", async () => {
		const out = await forTicket(
			onTicket([withLabel, ticketRead, [SEARCH, listing(bound(9412), bound(9431))]]),
		);
		expect(out.code).toBe(SESSION_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain(`ticket #${TICKET}`);
	});

	it.each([
		[NO_TARGET, "does not exist", NOT_FOUND],
		[PRECONDITION_UNKNOWN, "could not be read", GATEWAY],
	])("refuses on %i when the ticket %s, minting nothing", async (code, _case, reply) => {
		const seams = onTicket([withLabel, [TICKET_READ, reply]]);
		const out = await forTicket(seams);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(seams.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 19 rather than minting a second session past a body it could not parse", async () => {
		const drifted = row(9400, TITLE, `A grilling session.\n\n### Came from\n\n#${TICKET}\n`);
		const seams = onTicket([withLabel, ticketRead, [SEARCH, listing(drifted)]]);
		const out = await forTicket(seams);
		expect(out.code).toBe(BINDING_MALFORMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("#9400");
		expect(out.stderr.join("\n")).toContain("does not parse");
		expect(seams.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("reads a session bound to a different ticket as no match, not as a drift", async () => {
		const other = row(9400, TITLE, `A grilling session.\n\n${cameFromSection(4242)}`);
		const out = await forTicket(
			onTicket([
				withLabel,
				ticketRead,
				[SEARCH, listing(other)],
				[CREATE, created],
				[SESSION_READ, served(sessionPayload(9412, {labels: [], title: TITLE}))],
				[LABEL_WRITE, served("{}")],
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
