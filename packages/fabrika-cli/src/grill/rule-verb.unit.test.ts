import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {DocumentRead} from "./answer-verb.ts";
import {
	AUTHORIZATION_ABSENT,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	KIND_MISMATCH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	QUESTION_RETIRED,
	QUESTION_UNKNOWN,
	READBACK_MISMATCH,
	TOKEN_UNAUTHORIZED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	AUTHORIZATION,
	commentsPayload,
	roundComment,
	roundDigestOf,
	rulingComment,
	sessionPayload,
	supersedeComment,
} from "./fixtures.test-support.ts";
import {runRule} from "./rule-verb.ts";

const VIEWER = /^GET .*\/user$/;
const PERMISSION = /^GET .*\/repos\/o\/r\/collaborators\/[a-z-]+\/permission$/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/9412\/comments\?/;
const POST = /^POST .*\/repos\/o\/r\/issues\/9412\/comments$/;
const READBACK = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

const served = (body: string, status = 200): HttpReply => ({status, body});
const granted = (permission: string): HttpReply => served(JSON.stringify({permission}));
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const BOUND = roundDigestOf(1);
const ROUND_ONE = commentsPayload([{id: 1, author: "acme-founder", body: roundComment(1)}]);

const options = {
	session: 9412,
	question: "R1.2",
	authorizationPath: "authorization.md",
	authorization: Effect.succeed<DocumentRead>({_tag: "Text", text: AUTHORIZATION}),
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	now: () => new Date("2026-08-09T18:36:48.000Z"),
};

const postedAs = (id: number) =>
	served(JSON.stringify({id, html_url: `https://example.test/#${id}`}), 201);

const identity: ReadonlyArray<Scripted> = [
	[VIEWER, served(JSON.stringify({login: "acme-founder"}))],
	[PERMISSION, granted("write")],
];

const happy: ReadonlyArray<Scripted> = [
	...identity,
	[ISSUE, served(sessionPayload(9412))],
	[COMMENTS, served(ROUND_ONE)],
	[once(POST), postedAs(5234567893)],
	[POST, postedAs(5234567892)],
	[READBACK, served(JSON.stringify({body: rulingComment("R1.2", BOUND)}))],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runRule({...options, ...overrides}), fakeSeams(script).layer));

describe("runRule records a bound ruling", () => {
	it("answers with both comment ids and resolvesTo ruled", async () => {
		const out = await run(happy);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			session: 9412,
			question: "R1.2",
			digest: BOUND,
			authorization: 5234567893,
			marker: 5234567892,
			resolvesTo: "ruled",
		});
	});

	it("writes the authorization FIRST and the marker second", async () => {
		const seams = fakeSeams(happy);
		await Effect.runPromise(Effect.provide(runRule(options), seams.layer));
		const posts = seams.bodies.filter((_, at) => POST.test(seams.requests[at] ?? ""));
		expect(posts).toHaveLength(2);
		expect(posts[0]).toContain("weight is earned per account");
		expect(posts[0]).not.toContain("grill-ruled:");
		expect(posts[1]).toContain(`grill-ruled: R1.2 @ ${BOUND}`);
	});

	it("names the orphaned authorization when the marker write is the half that failed", async () => {
		const out = await run([
			...identity,
			[ISSUE, served(sessionPayload(9412))],
			[COMMENTS, served(ROUND_ONE)],
			[once(POST), postedAs(5234567893)],
			[POST, GATEWAY],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("#5234567893");
		expect(out.stderr.join("\n")).toContain("does NOT count");
	});
});

describe("runRule refuses without a quoted, dated authorization", () => {
	it.each([
		["an empty authorization", "   \n"],
		["an authorization carrying no ISO-8601 date", 'he said "do it that way"\n'],
	])("refuses %s on AUTHORIZATION_ABSENT with nothing written", async (_case, text) => {
		const seams = fakeSeams(happy);
		const out = await Effect.runPromise(
			Effect.provide(
				runRule({...options, authorization: Effect.succeed<DocumentRead>({_tag: "Text", text})}),
				seams.layer,
			),
		);
		expect(out.code).toBe(AUTHORIZATION_ABSENT);
		expect(seams.requests.some((request) => POST.test(request))).toBe(false);
	});
});

describe("runRule never grants authority from a failed lookup", () => {
	it("refuses a permission read that could not complete as UNKNOWN", async () => {
		const out = await run([
			[VIEWER, served(JSON.stringify({login: "acme-founder"}))],
			[PERMISSION, GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a token below write on its own code, distinct from UNKNOWN", async () => {
		const out = await run([
			[VIEWER, served(JSON.stringify({login: "acme-founder"}))],
			[PERMISSION, granted("read")],
		]);
		expect(out.code).toBe(TOKEN_UNAUTHORIZED);
	});

	it("refuses a token that is no collaborator at all", async () => {
		const out = await run([
			[VIEWER, served(JSON.stringify({login: "acme-founder"}))],
			[PERMISSION, NOT_FOUND],
		]);
		expect(out.code).toBe(TOKEN_UNAUTHORIZED);
	});

	it("resolves the ACL before it reads the session, so nothing is read on an unauthorized token", async () => {
		const seams = fakeSeams([
			[VIEWER, served(JSON.stringify({login: "acme-founder"}))],
			[PERMISSION, granted("read")],
		]);
		await Effect.runPromise(Effect.provide(runRule(options), seams.layer));
		expect(seams.requests.some((request) => ISSUE.test(request))).toBe(false);
	});
});

describe("runRule seats every other refusal on its own code", () => {
	const cases: ReadonlyArray<
		readonly [string, number, ReadonlyArray<Scripted>, Partial<typeof options>]
	> = [
		[
			"an authorization carrying a machine-local path",
			LEAKED_PATH,
			happy,
			{
				authorization: Effect.succeed<DocumentRead>({
					_tag: "Text",
					text: "2026-08-09 — see /Users/someone/notes.md",
				}),
			},
		],
		[
			"an authorization that is a bare @ path",
			BARE_AT_PATH,
			happy,
			{
				authorization: Effect.succeed<DocumentRead>({
					_tag: "Text",
					text: "@/Users/someone/authorization-2026-08-09.md",
				}),
			},
		],
		["an absent session", NO_TARGET, [...identity, [ISSUE, NOT_FOUND]], {}],
		["an id that names no question", QUESTION_UNKNOWN, happy, {question: "R9.9"}],
		["a fact question", KIND_MISMATCH, happy, {question: "R1.1"}],
		[
			"a retired question",
			QUESTION_RETIRED,
			[
				...identity,
				[ISSUE, served(sessionPayload(9412))],
				[
					COMMENTS,
					served(
						commentsPayload([
							{id: 1, author: "acme-founder", body: roundComment(1)},
							{
								id: 2,
								author: "acme-founder",
								body: supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]),
							},
						]),
					),
				],
			],
			{},
		],
		[
			"a round that cannot be digested",
			DIGEST_UNBINDABLE,
			[
				...identity,
				[ISSUE, served(sessionPayload(9412))],
				[
					COMMENTS,
					served(
						commentsPayload([
							{
								id: 1,
								author: "acme-founder",
								body: roundComment(1).replace(
									"**Trade-offs:** Slower trust accrual; simpler abuse story.",
									"",
								),
							},
						]),
					),
				],
			],
			{},
		],
		[
			"a read-back that differs",
			READBACK_MISMATCH,
			[
				...identity,
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, served(ROUND_ONE)],
				[once(POST), postedAs(5234567893)],
				[POST, postedAs(5234567892)],
				[READBACK, served(JSON.stringify({body: "something else"}))],
			],
			{},
		],
	];

	it.each(cases)("refuses %s on %i", async (_case, code, script, overrides) => {
		const out = await run(script, overrides);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("grill rule:");
	});
});
