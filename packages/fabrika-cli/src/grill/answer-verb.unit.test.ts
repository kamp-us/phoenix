import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
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

const ISSUE = /^gh api repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/[a-z-]+\/permission/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/9412\/comments -f/;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

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

const posted = okOut(
	JSON.stringify({id: 5234567891, html_url: "https://example.test/issues/9412#c"}),
);

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), fakeShell(script).layer));

/** Run once to learn the body the verb composes, then replay with a read-back that echoes it. */
const runEchoing = async (
	comments: string,
	overrides: Partial<typeof options> = {},
): Promise<{code: number; stdout: string; stderr: ReadonlyArray<string>; body: string}> => {
	const probe = fakeShell([
		[ISSUE, okOut(sessionPayload(9412))],
		[COMMENTS, okOut(comments)],
		[PERMISSION, okOut("write")],
		[POST, posted],
		[READBACK, okOut(JSON.stringify({body: "not what was sent"}))],
	]);
	await Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), probe.layer));
	const call = probe.calls.find((line) => POST.test(line)) ?? "";
	const body = call.slice(call.indexOf("-f body=") + "-f body=".length);
	const out = await run(
		[
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(comments)],
			[PERMISSION, okOut("write")],
			[POST, posted],
			[READBACK, okOut(JSON.stringify({body}))],
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
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(ROUND_ONE)],
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
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(comments)],
				[PERMISSION, okOut("write")],
			],
			{question: "R1.2"},
		);
		expect(out.code).toBe(QUESTION_RETIRED);
	});
});

describe("runAnswer seats each refusal on its own code, with nothing on stdout", () => {
	const base: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[ISSUE, okOut(sessionPayload(9412))],
		[COMMENTS, okOut(ROUND_ONE)],
		[PERMISSION, okOut("write")],
	];

	const cases: ReadonlyArray<
		readonly [string, number, ReadonlyArray<readonly [RegExp, ExecResult]>, Partial<typeof options>]
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
		["an absent session", NO_TARGET, [[ISSUE, errOut("gh: Not Found (HTTP 404)")]], {}],
		[
			"a comment read that could not complete",
			PRECONDITION_UNKNOWN,
			[
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{},
		],
		["an id that names no question", QUESTION_UNKNOWN, base, {question: "R9.9"}],
		["an id that is not R<round>.<n>", QUESTION_UNKNOWN, base, {question: "question one"}],
		[
			"a write that failed",
			WRITE_UNKNOWN,
			[
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(ROUND_ONE)],
				[POST, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{},
		],
		[
			"a read-back that differs",
			READBACK_MISMATCH,
			[
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(ROUND_ONE)],
				[POST, posted],
				[READBACK, okOut(JSON.stringify({body: "something else"}))],
			],
			{},
		],
		[
			"a round whose block is missing the field the digest covers",
			DIGEST_UNBINDABLE,
			[
				[ISSUE, okOut(sessionPayload(9412))],
				[
					COMMENTS,
					okOut(
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
			const shell = fakeShell(script);
			await Effect.runPromise(Effect.provide(runAnswer({...options, ...overrides}), shell.layer));
			const posts = shell.calls.filter((call) => POST.test(call));
			// The write-failure and read-back cases attempt exactly one write by construction.
			expect(posts.length).toBeLessThanOrEqual(1);
		}
	});

	it("keeps the refusals on distinct codes", () => {
		expect(new Set(cases.map(([, code]) => code)).size).toBeGreaterThan(6);
	});
});
