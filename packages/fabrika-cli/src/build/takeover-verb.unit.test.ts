import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {DocumentRead} from "./clear-verb.ts";
import {
	AUTHORIZATION_VOID,
	GRANT_UNAUTHORIZED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments, pull, served} from "./fixtures.test-support.ts";
import {runTakeover} from "./takeover-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4310$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4310\/comments/;
const VIEWER = /^GET \S+\/user$/;
const CONFIG = /^GET \S+\/repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
const permissionOf = (login: string) =>
	new RegExp(`^GET \\S+/repos/o/r/collaborators/${login}/permission`);
const POST = /^POST \S+\/repos\/o\/r\/issues\/4310\/comments/;
const GET_COMMENT = /^GET \S+\/repos\/o\/r\/issues\/comments\/\d+$/;

const NOW = new Date("2026-09-26T07:16:03Z");
const AUTHORIZATION = 'Founder, 2026-09-26: "take over #4310, Ada is away."';
const MARKER = "takeover-granted: #4310 · 2026-09-26T07:16:03Z\n";
const BODY = `${MARKER}\n${AUTHORIZATION}\n`;

const config = (value: Record<string, unknown>): HttpReply => ({
	status: 200,
	body: JSON.stringify(value),
});
const GRANTORS = config({capClearAuthors: ["@founder"]});

const document = (text: string): Effect.Effect<DocumentRead> =>
	Effect.succeed({_tag: "Text", text});

const options = {
	pr: 4310,
	authorizationPath: "authorization.md",
	authorization: document(AUTHORIZATION),
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
		string,
		string | undefined
	>,
	now: () => NOW,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(runTakeover({...options, ...overrides}), seams.layer),
	).then((outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}));
};

const ADA_PR: Scripted = [PULL, pull({number: 4310, base: {ref: "main"}, user: {login: "ada"}})];

const grantable = (running = "founder", base: HttpReply = GRANTORS): ReadonlyArray<Scripted> => [
	ADA_PR,
	[VIEWER, served({login: running})],
	[CONFIG, base],
	[permissionOf(running), served({permission: "write"})],
];

const posted = (requests: ReadonlyArray<string>) => requests.some((line) => POST.test(line));

describe("runTakeover", () => {
	it("posts one comment — the marker over the quoted authorization — and reads it back", async () => {
		const {outcome, requests, bodies} = await run([
			...grantable(),
			[COMMENTS, comments()],
			[POST, served({id: 900, html_url: "https://x/y#c"}, 201)],
			[GET_COMMENT, served({body: BODY})],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			pr: 4310,
			author: "ada",
			by: "founder",
			comment: 900,
			at: "2026-09-26T07:16:03Z",
			resolvesTo: "granted",
		});
		const sent = bodies.filter((_, index) => requests[index]?.startsWith("POST") === true);
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0] ?? "{}").body).toBe(BODY);
	});

	it("answers already-granted and posts nothing when an honoured grant stands", async () => {
		const {outcome, requests} = await run([
			...grantable(),
			[COMMENTS, comments({id: 77, author: "founder", body: BODY})],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({resolvesTo: "already-granted", comment: 77});
		expect(posted(requests)).toBe(false);
	});

	it("refuses at 7 on a PR one of ours opened — it needs no grant", async () => {
		const {outcome, requests} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}, user: {login: "agent-bot"}})],
			[VIEWER, served({login: "founder"})],
			[CONFIG, config({capClearAuthors: ["@founder"], ownAccounts: ["@agent-bot"]})],
			[permissionOf("founder"), served({permission: "write"})],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(posted(requests)).toBe(false);
	});

	it("refuses at 25 when the invoking account opened the PR itself", async () => {
		const {outcome, requests} = await run(grantable("ada", config({capClearAuthors: ["@ada"]})));
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
		expect(outcome.stderr.at(-1)).toContain("an author cannot hand their own PR over");
		expect(posted(requests)).toBe(false);
	});

	it("refuses at 25 when the invoking account is outside the grant-author set", async () => {
		const {outcome, requests} = await run(grantable("mallory"));
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
		expect(posted(requests)).toBe(false);
	});

	it("refuses at 25 when nobody may grant — the shipped default", async () => {
		const {outcome} = await run(grantable("founder", config({})));
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
	});

	it("refuses at 25 when a configured account holds less than write", async () => {
		const {outcome} = await run([
			ADA_PR,
			[VIEWER, served({login: "founder"})],
			[CONFIG, GRANTORS],
			[permissionOf("founder"), served({permission: "read"})],
		]);
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
	});

	it.each([
		["empty", "   "],
		["undated", "take it over"],
	])("refuses at 26 on an %s authorization, before any read", async (_name, text) => {
		const {outcome, requests} = await run([], {authorization: document(text)});
		expect(outcome.code).toBe(AUTHORIZATION_VOID);
		expect(requests).toHaveLength(0);
	});

	it("refuses at 11 when the config at the base cannot be read", async () => {
		const {outcome} = await run(grantable("founder", {status: 502, body: '{"message":"Bad"}'}));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses at 9 when the posted grant does not read back", async () => {
		const {outcome} = await run([
			...grantable(),
			[COMMENTS, comments()],
			[POST, served({id: 900, html_url: "https://x/y#c"}, 201)],
			[GET_COMMENT, served({body: "something else\n"})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
