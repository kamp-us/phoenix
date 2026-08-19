import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {coderTemplateText} from "../lane/fixtures.test-support.ts";
import {compileText} from "../lane/machine.ts";
import {CAP_ROUND, RETRY_BUDGET} from "../retry-budget.ts";
import {type DocumentRead, runClear} from "./clear-verb.ts";
import {AUTHORIZATION_VOID, GRANT_UNAUTHORIZED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {comments, HEAD, PRIOR_HEADS, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4310$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4310\/comments/;
const VIEWER = /^gh api user --jq \.login$/;
const CONFIG =
	/^gh api -H Accept: application\/vnd\.github\.raw repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
const TEAM = /^gh api --paginate orgs\/kamp-us\/teams\/control-plane\/members/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/usirin\/permission/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/4310\/comments/;
const GET_COMMENT = /^gh api repos\/o\/r\/issues\/comments\/(\d+)$/;

const WORKFLOW = ".fabrika/lanes/4312/workflow.json";
const NOW = new Date("2026-08-18T07:16:03Z");
const AUTHORIZATION = 'Founder ruling 2026-08-18: "one more round on this one."';

/** Three graded heads — three rounds, the count at which the declared budget is spent. */
const THREE_ROUND_COMMENTS = [
	{id: 1, body: `review-code: FAIL @ ${PRIOR_HEADS[0]} — one`, createdAt: "2026-08-18T01:00:00Z"},
	{id: 2, body: `review-code: FAIL @ ${PRIOR_HEADS[1]} — two`, createdAt: "2026-08-18T02:00:00Z"},
	{id: 3, body: `review-code: FAIL @ ${PRIOR_HEADS[2]} — three`, createdAt: "2026-08-18T03:00:00Z"},
];
const THREE_ROUNDS = comments(...THREE_ROUND_COMMENTS);

const CONFIGURED = okOut('{\n\t// the founder accounts\n\t"capClearAuthors": ["@usirin"]\n}\n');
const POSTED = (id: number): ExecResult => okOut(JSON.stringify({id, html_url: "https://x/y#c"}));

const document = (text: string): Effect.Effect<DocumentRead> =>
	Effect.succeed(text === "" ? {_tag: "Failed", reason: "no such file"} : {_tag: "Text", text});

const options = {
	pr: 4310,
	authorizationPath: "authorization.md",
	authorization: document(AUTHORIZATION),
	laneRoot: null,
	task: null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	now: () => NOW,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	files: Record<string, string | null> = {},
) => {
	const shell = fakeShell(script);
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(runClear({...options, ...overrides}), Layer.merge(shell.layer, fs.layer)),
	).then((outcome) => ({outcome, inputs: shell.inputs, calls: shell.calls, written: fs.written}));
};

const GRANTABLE: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[PULL, pull({number: 4310, base: {ref: "main"}})],
	[COMMENTS, THREE_ROUNDS],
	[CONFIG, CONFIGURED],
	[VIEWER, okOut("usirin\n")],
	[PERMISSION, okOut("admin\n")],
];

describe("runClear", () => {
	it("posts the authorization first and the marker second, then answers `cleared`", async () => {
		const {outcome, calls} = await run(
			[
				...GRANTABLE,
				[POST, POSTED(900)],
				[
					GET_COMMENT,
					okOut(JSON.stringify({body: "cap-cleared: round 3 · 2026-08-18T07:16:03Z\n"})),
				],
			],
			{},
			{[WORKFLOW]: coderTemplateText()},
		);
		expect(outcome.code).toBe(0);
		const parsed = JSON.parse(outcome.stdout);
		expect(parsed).toMatchObject({round: CAP_ROUND, by: "usirin", resolvesTo: "cleared"});
		expect(parsed.cap).toBe(CAP_ROUND + 1);
		const posted = calls.filter((line) => line.includes("--method POST"));
		expect(posted[0]).toContain("Founder ruling 2026-08-18");
		expect(posted[1]).toContain("cap-cleared: round 3");
	});

	it("carries the grant into the local lane, so the guard does not freeze the cleared round", async () => {
		const {written} = await run(
			[
				...GRANTABLE,
				[POST, POSTED(900)],
				[
					GET_COMMENT,
					okOut(JSON.stringify({body: "cap-cleared: round 3 · 2026-08-18T07:16:03Z\n"})),
				],
			],
			{},
			{[WORKFLOW]: coderTemplateText()},
		);
		const compiled = compileText(written.get(WORKFLOW) ?? "");
		if (compiled._tag !== "Compiled") throw new Error("the lane document did not recompile");
		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(RETRY_BUDGET + 1);
	});

	it("refuses an account outside the configured set, writing nothing", async () => {
		const {outcome, calls} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[COMMENTS, THREE_ROUNDS],
			[CONFIG, CONFIGURED],
			[VIEWER, okOut("someone-else\n")],
		]);
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
		expect(calls.some((line) => /--method POST/.test(line))).toBe(false);
	});

	it("refuses when the repo configures nobody — an absent config grants nobody (#5959)", async () => {
		const {outcome} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[COMMENTS, THREE_ROUNDS],
			[CONFIG, {ok: false, stdout: "", reason: "gh: Not Found (HTTP 404)"}],
			[VIEWER, okOut("usirin\n")],
		]);
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
	});

	it("holds an unreadable team membership UNKNOWN rather than granting or refusing", async () => {
		const {outcome} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[COMMENTS, THREE_ROUNDS],
			[CONFIG, okOut('{"capClearAuthors": ["@kamp-us/control-plane"]}')],
			[TEAM, {ok: false, stdout: "", reason: "HTTP 502"}],
			[VIEWER, okOut("usirin\n")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a bare stamp — an authorization with no date is void (#4938)", async () => {
		const {outcome, calls} = await run(GRANTABLE, {
			authorization: document("one more round, go ahead"),
		});
		expect(outcome.code).toBe(AUTHORIZATION_VOID);
		expect(calls).toEqual([]);
	});

	it("refuses an empty authorization before reading anything", async () => {
		const {outcome} = await run(GRANTABLE, {
			authorization: Effect.succeed({_tag: "Text", text: " "}),
		});
		expect(outcome.code).toBe(AUTHORIZATION_VOID);
	});

	/** Clearing a budget that is not spent would pre-arm a round nobody has needed yet. */
	it("refuses while the budget still has rounds in it", async () => {
		const {outcome} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[
				COMMENTS,
				comments({
					id: 1,
					body: `review-code: FAIL @ ${HEAD} — one`,
					createdAt: "2026-08-18T01:00:00Z",
				}),
			],
			[CONFIG, CONFIGURED],
			[VIEWER, okOut("usirin\n")],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("counts an already-honoured clearance, so the second grant clears the next round", async () => {
		const {outcome} = await run(
			[
				[PULL, pull({number: 4310, base: {ref: "main"}})],
				[
					COMMENTS,
					comments(
						...THREE_ROUND_COMMENTS,
						{id: 4, body: AUTHORIZATION, author: "usirin", createdAt: "2026-08-18T03:10:00Z"},
						{
							id: 5,
							body: "cap-cleared: round 3 · 2026-08-18T03:11:00Z",
							author: "usirin",
							createdAt: "2026-08-18T03:11:00Z",
						},
						{id: 6, body: `review-code: FAIL @ ${HEAD} — four`, createdAt: "2026-08-18T04:00:00Z"},
					),
				],
				[CONFIG, CONFIGURED],
				[VIEWER, okOut("usirin\n")],
				[PERMISSION, okOut("admin\n")],
				[POST, POSTED(901)],
				[
					GET_COMMENT,
					okOut(JSON.stringify({body: "cap-cleared: round 4 · 2026-08-18T07:16:03Z\n"})),
				],
			],
			{},
			{[WORKFLOW]: coderTemplateText()},
		);
		expect(outcome.code).toBe(0);
		const parsed = JSON.parse(outcome.stdout);
		expect(parsed.round).toBe(CAP_ROUND + 1);
		expect(parsed.cap).toBe(CAP_ROUND + 2);
	});

	/** A committed set narrows the ACL; it never stands in for one (ADR 0055, ADR 0294). */
	it("refuses a configured account that resolves below write at the ACL", async () => {
		const {outcome, calls} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[COMMENTS, THREE_ROUNDS],
			[CONFIG, CONFIGURED],
			[VIEWER, okOut("usirin\n")],
			[PERMISSION, okOut("read\n")],
		]);
		expect(outcome.code).toBe(GRANT_UNAUTHORIZED);
		expect(outcome.stderr.at(-1)).toContain("below write");
		expect(calls.some((line) => /--method POST/.test(line))).toBe(false);
	});

	it("holds an unreadable permission UNKNOWN rather than granting on the config alone", async () => {
		const {outcome} = await run([
			[PULL, pull({number: 4310, base: {ref: "main"}})],
			[COMMENTS, THREE_ROUNDS],
			[CONFIG, CONFIGURED],
			[VIEWER, okOut("usirin\n")],
			[PERMISSION, {ok: false, stdout: "", reason: "HTTP 502"}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	/**
	 * Exit 29's own remedy: the marker landed and the lane write did not, so the raised cap is what
	 * now makes the budget test say "not spent". The re-run must reconcile the lane, not refuse on 7.
	 */
	it("reconciles the lane on a re-run for a round already granted, posting nothing", async () => {
		const {outcome, calls, written} = await run(
			[
				[PULL, pull({number: 4310, base: {ref: "main"}})],
				[
					COMMENTS,
					comments(
						...THREE_ROUND_COMMENTS,
						{id: 4, body: AUTHORIZATION, author: "usirin", createdAt: "2026-08-18T03:10:00Z"},
						{
							id: 5,
							body: "cap-cleared: round 3 · 2026-08-18T03:11:00Z",
							author: "usirin",
							createdAt: "2026-08-18T03:11:00Z",
						},
					),
				],
				[CONFIG, CONFIGURED],
				[VIEWER, okOut("usirin\n")],
				[PERMISSION, okOut("admin\n")],
			],
			{},
			{[WORKFLOW]: coderTemplateText()},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			round: CAP_ROUND,
			marker: 5,
			authorization: 4,
			resolvesTo: "reconciled",
		});
		expect(calls.some((line) => /--method POST/.test(line))).toBe(false);
		const compiled = compileText(written.get(WORKFLOW) ?? "");
		if (compiled._tag !== "Compiled") throw new Error("the lane document did not recompile");
		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(RETRY_BUDGET + 1);
	});
});
