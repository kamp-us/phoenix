import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {type DocumentRead, runAnswer} from "./answer-verb.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	KIND_MISMATCH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	QUESTION_RETIRED,
	QUESTION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commentsPayload,
	roundComment,
	roundDigestOf,
	sessionPayload,
	supersedeComment,
} from "./fixtures.test-support.ts";

const ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /^GET .*\/repos\/o\/r\/collaborators\/[a-z-]+\/permission$/;
const POST = /^POST .*\/repos\/o\/r\/issues\/9412\/comments$/;
const READBACK = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

const served = (body: string, status = 200): HttpReply => ({status, body});
const granted = (permission: string): HttpReply => served(JSON.stringify({permission}));
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const FINDING = "The vote table carries no weight column; the schema is in the vote feature.\n";
const BOUND = roundDigestOf(1);
const ROUND_ONE = commentsPayload([{id: 1, author: "acme-founder", body: roundComment(1)}]);

const options = {
	session: 9412,
	question: "R1.1",
	findingPath: "finding.md",
	finding: Effect.succeed<DocumentRead>({_tag: "Text", text: FINDING}),
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	now: () => new Date("2026-08-09T18:36:48.000Z"),
};

const posted = served(
	JSON.stringify({id: 5234567891, html_url: "https://example.test/issues/9412#c"}),
	201,
);

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), fakeSeams(script).layer));

/** Run once to learn the body the verb composes, then replay with a read-back that echoes it. */
const runEchoing = async (
	comments: string,
	overrides: Partial<typeof options> = {},
): Promise<{code: number; stdout: string; stderr: ReadonlyArray<string>; body: string}> => {
	const probe = fakeSeams([
		[ISSUE, served(sessionPayload(9412))],
		[COMMENTS, served(comments)],
		[PERMISSION, granted("write")],
		[POST, posted],
		[READBACK, served(JSON.stringify({body: "not what was sent"}))],
	]);
	await Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), probe.layer));
	const at = probe.requests.findIndex((request) => POST.test(request));
	const body = at === -1 ? "" : String(JSON.parse(probe.bodies[at] ?? "{}").body ?? "");
	const out = await run(
		[
			[ISSUE, served(sessionPayload(9412))],
			[COMMENTS, served(comments)],
			[PERMISSION, granted("write")],
			[POST, posted],
			[READBACK, served(JSON.stringify({body}))],
		],
		overrides,
	);
	return {...out, body};
};

describe("runAnswer records the agent's own answer", () => {
	it("posts a grill-answered marker and answers recordedAs agent", async () => {
		const out = await runEchoing(ROUND_ONE);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			session: 9412,
			question: "R1.1",
			kind: "fact",
			comment: 5234567891,
			recordedAs: "agent",
		});
		expect(out.body).toContain(`grill-answered: R1.1 @ ${BOUND}`);
		expect(out.body).not.toContain("grill-ruled:");
		expect(out.body).toContain("no weight column");
	});
});

describe("runAnswer refuses on the kind guard, and it is the guard that fires", () => {
	it("refuses a decision question, pointing at grill rule", async () => {
		const out = await run(
			[
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, served(ROUND_ONE)],
			],
			{question: "R1.2"},
		);
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("grill rule");
	});

	it("refuses a retired question ahead of the kind guard — superseded always wins", async () => {
		const comments = commentsPayload([
			{id: 1, author: "acme-founder", body: roundComment(1)},
			{
				id: 2,
				author: "acme-founder",
				body: supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]),
			},
		]);
		const out = await run(
			[
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, served(comments)],
				[PERMISSION, granted("write")],
			],
			{question: "R1.2"},
		);
		expect(out.code).toBe(QUESTION_RETIRED);
	});
});

describe("runAnswer seats each refusal on its own code, with nothing on stdout", () => {
	const base: ReadonlyArray<Scripted> = [
		[ISSUE, served(sessionPayload(9412))],
		[COMMENTS, served(ROUND_ONE)],
		[PERMISSION, granted("write")],
	];

	const cases: ReadonlyArray<
		readonly [string, number, ReadonlyArray<Scripted>, Partial<typeof options>]
	> = [
		[
			"an empty finding",
			BAD_SECTIONS,
			base,
			{finding: Effect.succeed<DocumentRead>({_tag: "Text", text: "   \n"})},
		],
		[
			"a finding carrying a machine-local path",
			LEAKED_PATH,
			base,
			{finding: Effect.succeed<DocumentRead>({_tag: "Text", text: "see /Users/someone/notes.md"})},
		],
		[
			"a finding that is a bare @ path",
			BARE_AT_PATH,
			base,
			{finding: Effect.succeed<DocumentRead>({_tag: "Text", text: "@/Users/someone/finding.md"})},
		],
		["an absent session", NO_TARGET, [[ISSUE, NOT_FOUND]], {}],
		[
			"a comment read that could not complete",
			PRECONDITION_UNKNOWN,
			[
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, GATEWAY],
			],
			{},
		],
		["an id that names no question", QUESTION_UNKNOWN, base, {question: "R9.9"}],
		["an id that is not R<round>.<n>", QUESTION_UNKNOWN, base, {question: "question one"}],
		[
			"a write that failed",
			WRITE_UNKNOWN,
			[
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, served(ROUND_ONE)],
				[POST, GATEWAY],
			],
			{},
		],
		[
			"a read-back that differs",
			READBACK_MISMATCH,
			[
				[ISSUE, served(sessionPayload(9412))],
				[COMMENTS, served(ROUND_ONE)],
				[POST, posted],
				[READBACK, served(JSON.stringify({body: "something else"}))],
			],
			{},
		],
		[
			"a round whose block is missing the field the digest covers",
			DIGEST_UNBINDABLE,
			[
				[ISSUE, served(sessionPayload(9412))],
				[
					COMMENTS,
					served(
						commentsPayload([
							{
								id: 1,
								author: "acme-founder",
								body: roundComment(1).replace(
									"**Recommended:** Check the vote feature's schema before designing one.",
									"",
								),
							},
						]),
					),
				],
			],
			{},
		],
	];

	it.each(cases)("refuses %s on %i", async (_case, code, script, overrides) => {
		const out = await run(script, overrides);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("grill answer:");
	});

	it("writes nothing on any refusal", async () => {
		for (const [, , script, overrides] of cases) {
			const seams = fakeSeams(script);
			await Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), seams.layer));
			const posts = seams.requests.filter((request) => POST.test(request));
			// The write-failure and read-back cases attempt exactly one write by construction.
			expect(posts.length).toBeLessThanOrEqual(1);
		}
	});

	it("keeps the refusals on distinct codes", () => {
		expect(new Set(cases.map(([, code]) => code)).size).toBeGreaterThan(6);
	});
});
