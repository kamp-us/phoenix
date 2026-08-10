import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
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

const VIEWER = /^gh api user --jq \.login$/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/[a-z-]+\/permission/;
const ISSUE = /^gh api repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9412\/comments\?/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/9412\/comments -f/;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

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
	okOut(JSON.stringify({id, html_url: `https://example.test/#${id}`}));

const identity: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[VIEWER, okOut("acme-founder")],
	[PERMISSION, okOut("write")],
];

const happy: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	...identity,
	[ISSUE, okOut(sessionPayload(9412))],
	[COMMENTS, okOut(ROUND_ONE)],
	[once(POST), postedAs(5234567893)],
	[POST, postedAs(5234567892)],
	[READBACK, okOut(JSON.stringify({body: rulingComment("R1.2", BOUND)}))],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runRule({...options, ...overrides}), fakeShell(script).layer));

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
		const shell = fakeShell(happy);
		await Effect.runPromise(Effect.provide(runRule(options), shell.layer));
		const posts = shell.calls.filter((call) => POST.test(call));
		expect(posts).toHaveLength(2);
		expect(posts[0]).toContain("weight is earned per account");
		expect(posts[0]).not.toContain("grill-ruled:");
		expect(posts[1]).toContain(`grill-ruled: R1.2 @ ${BOUND}`);
	});

	it("names the orphaned authorization when the marker write is the half that failed", async () => {
		const out = await run([
			...identity,
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(ROUND_ONE)],
			[once(POST), postedAs(5234567893)],
			[POST, errOut("gh: Bad gateway (HTTP 502)")],
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
		const shell = fakeShell(happy);
		const out = await Effect.runPromise(
			Effect.provide(
				runRule({...options, authorization: Effect.succeed<DocumentRead>({_tag: "Text", text})}),
				shell.layer,
			),
		);
		expect(out.code).toBe(AUTHORIZATION_ABSENT);
		expect(shell.calls.some((call) => POST.test(call))).toBe(false);
	});
});

describe("runRule never grants authority from a failed lookup", () => {
	it("refuses a permission read that could not complete as UNKNOWN", async () => {
		const out = await run([
			[VIEWER, okOut("acme-founder")],
			[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a token below write on its own code, distinct from UNKNOWN", async () => {
		const out = await run([
			[VIEWER, okOut("acme-founder")],
			[PERMISSION, okOut("read")],
		]);
		expect(out.code).toBe(TOKEN_UNAUTHORIZED);
	});

	it("refuses a token that is no collaborator at all", async () => {
		const out = await run([
			[VIEWER, okOut("acme-founder")],
			[PERMISSION, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(TOKEN_UNAUTHORIZED);
	});

	it("resolves the ACL before it reads the session, so nothing is read on an unauthorized token", async () => {
		const shell = fakeShell([
			[VIEWER, okOut("acme-founder")],
			[PERMISSION, okOut("read")],
		]);
		await Effect.runPromise(Effect.provide(runRule(options), shell.layer));
		expect(shell.calls.some((call) => ISSUE.test(call))).toBe(false);
	});
});

describe("runRule seats every other refusal on its own code", () => {
	const cases: ReadonlyArray<
		readonly [string, number, ReadonlyArray<readonly [RegExp, ExecResult]>, Partial<typeof options>]
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
		[
			"an absent session",
			NO_TARGET,
			[...identity, [ISSUE, errOut("gh: Not Found (HTTP 404)")]],
			{},
		],
		["an id that names no question", QUESTION_UNKNOWN, happy, {question: "R9.9"}],
		["a fact question", KIND_MISMATCH, happy, {question: "R1.1"}],
		[
			"a retired question",
			QUESTION_RETIRED,
			[
				...identity,
				[ISSUE, okOut(sessionPayload(9412))],
				[
					COMMENTS,
					okOut(
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
				[ISSUE, okOut(sessionPayload(9412))],
				[
					COMMENTS,
					okOut(
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
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(ROUND_ONE)],
				[once(POST), postedAs(5234567893)],
				[POST, postedAs(5234567892)],
				[READBACK, okOut(JSON.stringify({body: "something else"}))],
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
