import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	EMPTY_STDIN,
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
	ROUND_BODY,
	roundComment,
	roundDigestOf,
	sessionPayload,
	supersedeComment,
} from "./fixtures.test-support.ts";
import {runRound} from "./round-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/([a-z-]+)\/permission/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/9412\/comments -f/;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

const options = {
	session: 9412,
	supersedes: [] as ReadonlyArray<string>,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: ROUND_BODY}),
	now: () => new Date("2026-08-09T18:36:48.000Z"),
};

const postedAs = (id: number) =>
	okOut(JSON.stringify({id, html_url: `https://example.test/issues/9412#issuecomment-${id}`}));

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runRound({...options, ...overrides}), fakeShell(script).layer));

/**
 * A script whose read-back echoes the body the verb composed. The composed round is derived from the
 * same fixture builder the verb uses, so an echo is a real read-back rather than a rubber stamp.
 */
const happy = (
	comments: string = commentsPayload([]),
	round = 1,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[ISSUE, okOut(sessionPayload(9412))],
	[COMMENTS, okOut(comments)],
	[POST, postedAs(5234567890)],
	[READBACK, okOut(JSON.stringify({body: roundComment(round)}))],
];

describe("runRound derives the round number and stamps the ids", () => {
	it("posts round 1 on a session with no rounds", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			session: 9412,
			round: 1,
			digest: roundDigestOf(1),
			questions: [
				{id: "R1.1", kind: "fact"},
				{id: "R1.2", kind: "decision"},
			],
			supersedes: [],
			comment: 5234567890,
			supersedeComment: null,
		});
	});

	it("derives round 2 when round 1 is already posted", async () => {
		const out = await run(
			happy(commentsPayload([{id: 1, author: "acme-founder", body: roundComment(1)}]), 2),
		);
		expect(JSON.parse(out.stdout)).toMatchObject({round: 2, digest: roundDigestOf(2)});
	});

	it("never asks the caller for the round number — the stdin headings carry only a position", () => {
		expect(ROUND_BODY).not.toContain("R1.");
		expect(ROUND_BODY).toContain("### 1 · fact");
	});
});

describe("runRound validates the grammar before it writes", () => {
	it.each([
		["a question with no **Recommended:** field", "### 1 · fact\nIs there a column?\n"],
		["a heading that is not a question block", "### Background\nprose\n"],
		["a kind outside the set", "### 1 · musing\nWhat if?\n\n**Recommended:** x\n"],
	])("refuses %s on BAD_SECTIONS with nothing posted", async (_case, text) => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(
				runRound({...options, stdin: Effect.succeed<StdinRead>({_tag: "Text", text})}),
				shell.layer,
			),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((call) => POST.test(call))).toBe(false);
	});

	it("refuses an empty stdin on its own code", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed<StdinRead>({_tag: "NoStdin", reason: "fd 0 is a tty"}),
		});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it.each([
		[
			"a machine-local path",
			`${ROUND_BODY}\n**Trade-offs:** see /Users/someone/notes.md\n`,
			LEAKED_PATH,
		],
		["a bare @ path body", "@/Users/someone/round.md", BARE_AT_PATH],
	])("refuses %s before any write", async (_case, text, code) => {
		const stdin = Effect.succeed<StdinRead>({_tag: "Text", text});
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(Effect.provide(runRound({...options, stdin}), shell.layer));
		expect(out.code).toBe(code);
		expect(shell.calls.some((call) => POST.test(call))).toBe(false);
	});
});

describe("runRound seats each read and write failure on its own code", () => {
	it("refuses an absent session as proven, never as unreadable", async () => {
		const out = await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(NO_TARGET);
	});

	it("refuses an issue that is not a grilling session", async () => {
		const out = await run([[ISSUE, okOut(sessionPayload(9412, {labels: ["bug"]}))]]);
		expect(out.code).toBe(NO_TARGET);
	});

	it("refuses a comment read that could not complete — the next round number is UNKNOWN", async () => {
		const shell = fakeShell([
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		const out = await Effect.runPromise(Effect.provide(runRound(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((call) => POST.test(call))).toBe(false);
	});

	it("refuses a truncated comment page rather than answering short", async () => {
		const out = await run([
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(`${commentsPayload([])}[{"id":`)],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a comment write that failed as UNKNOWN, never as 1", async () => {
		const out = await run([
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(commentsPayload([]))],
			[POST, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a read-back that differs from what was sent", async () => {
		const out = await run([
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(commentsPayload([]))],
			[POST, postedAs(5234567890)],
			[READBACK, okOut(JSON.stringify({body: "something else"}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});

describe("runRound --supersedes retires a question", () => {
	const bound = roundDigestOf(1);
	const withRoundOne = commentsPayload([{id: 1, author: "acme-founder", body: roundComment(1)}]);

	const supersedeScript = (comments: string): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[ISSUE, okOut(sessionPayload(9412))],
		[COMMENTS, okOut(comments)],
		[PERMISSION, okOut("write")],
		[once(POST), postedAs(5234567890)],
		[once(READBACK), okOut(JSON.stringify({body: roundComment(2)}))],
		[POST, postedAs(5234567891)],
		[
			READBACK,
			okOut(
				JSON.stringify({
					body: supersedeComment([{question: "R1.2", digest: bound, round: 2}]),
				}),
			),
		],
	];

	it("writes the round first and the marker second, naming both ids", async () => {
		const shell = fakeShell(supersedeScript(withRoundOne));
		const out = await Effect.runPromise(
			Effect.provide(runRound({...options, supersedes: ["R1.2"]}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			round: 2,
			supersedes: ["R1.2"],
			comment: 5234567890,
			supersedeComment: 5234567891,
		});
		const posts = shell.calls.filter((call) => POST.test(call));
		expect(posts[0]).toContain("grill-round: 2");
		expect(posts[1]).toContain("grill-superseded: R1.2");
	});

	it("binds the RETIRED question's round digest, not the retiring round's", async () => {
		const shell = fakeShell(supersedeScript(withRoundOne));
		await Effect.runPromise(
			Effect.provide(runRound({...options, supersedes: ["R1.2"]}), shell.layer),
		);
		const marker = shell.calls.filter((call) => POST.test(call))[1] ?? "";
		expect(marker).toContain(roundDigestOf(1));
		expect(marker).not.toContain(roundDigestOf(2));
	});

	it("refuses an id that names no question", async () => {
		const out = await run(supersedeScript(withRoundOne), {supersedes: ["R1.9"]});
		expect(out.code).toBe(QUESTION_UNKNOWN);
	});

	it("refuses an id already superseded", async () => {
		const comments = commentsPayload([
			{id: 1, author: "acme-founder", body: roundComment(1)},
			{
				id: 2,
				author: "acme-founder",
				body: supersedeComment([{question: "R1.2", digest: bound, round: 2}]),
			},
		]);
		const out = await run(supersedeScript(comments), {supersedes: ["R1.2"]});
		expect(out.code).toBe(QUESTION_RETIRED);
	});

	it("refuses when the retired question's round cannot be digested", async () => {
		const partial = roundComment(1).replace(/\*\*Recommended:\*\*.*\n/, "");
		const comments = commentsPayload([{id: 1, author: "acme-founder", body: partial}]);
		const out = await run(supersedeScript(comments), {supersedes: ["R1.2"]});
		expect([DIGEST_UNBINDABLE, QUESTION_UNKNOWN]).toContain(out.code);
	});

	it("refuses when a marker author's permission could not be read — retirement is UNKNOWN", async () => {
		const comments = commentsPayload([
			{id: 1, author: "acme-founder", body: roundComment(1)},
			{
				id: 2,
				author: "stranger",
				body: supersedeComment([{question: "R1.1", digest: bound, round: 2}]),
			},
		]);
		const shell = fakeShell([
			[ISSUE, okOut(sessionPayload(9412))],
			[COMMENTS, okOut(comments)],
			[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRound({...options, supersedes: ["R1.2"]}), shell.layer),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((call) => POST.test(call))).toBe(false);
	});

	it("costs no ACL read at all when nothing is being retired", async () => {
		const shell = fakeShell(happy(withRoundOne, 2));
		await Effect.runPromise(Effect.provide(runRound(options), shell.layer));
		expect(shell.calls.some((call) => PERMISSION.test(call))).toBe(false);
	});
});
