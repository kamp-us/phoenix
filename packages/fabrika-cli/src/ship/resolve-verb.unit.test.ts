import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {ENV, pull, threadPage} from "./fixtures.test-support.ts";
import {runResolve} from "./resolve-verb.ts";

/** The pull read is `../io/pulls.ts`'s, served over HTTP. */
const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;

/**
 * Every thread leg is a POST to the one GraphQL endpoint, so the request line cannot tell them
 * apart — `once` is what sequences the four legs, and `bodies` is what proves which query each was.
 */
const graphql = (): RegExp => once(/^POST \S+\/graphql$/);

const bot = {login: "github-advanced-security", typename: "Bot"};
const RATIONALE = "Resolving: the unused import this flags was removed at this head.";
const URL = "https://github.com/o/r/pull/4321#discussion_r5154991";

const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const openBotThread = served(
	threadPage(1, [
		{
			id: "PRRT_kwDOLxx1",
			path: "src/cart.ts",
			line: 14,
			comments: [{...bot, body: "unused import"}],
		},
	]),
);
const resolvedWithRationale = served(
	threadPage(1, [
		{
			id: "PRRT_kwDOLxx1",
			isResolved: true,
			path: "src/cart.ts",
			line: 14,
			comments: [
				{...bot, body: "unused import"},
				{login: "usirin", typename: "User", body: RATIONALE},
			],
		},
	]),
);

const replied: HttpReply = {
	status: 200,
	body: JSON.stringify({data: {addPullRequestReviewThreadReply: {comment: {url: URL}}}}),
};
const resolvedOk: HttpReply = {
	status: 200,
	body: JSON.stringify({
		data: {resolveReviewThread: {thread: {id: "PRRT_kwDOLxx1", isResolved: true}}},
	}),
};
const badGateway: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const options = {
	pr: 4321,
	thread: "PRRT_kwDOLxx1",
	repo: null,
	json: false,
	env: ENV,
	stdin: Effect.succeed({_tag: "Text", text: RATIONALE} as StdinRead),
};

const both = (
	rows: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
) => {
	const seams = fakeSeams([...rows, ...http]);
	return {
		seams,
		outcome: Effect.runPromise(Effect.provide(runResolve({...options, ...overrides}), seams.layer)),
	};
};

const run = (
	rows: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
) => both(rows, http, overrides).outcome;

describe("runResolve", () => {
	it("replies, resolves and proves both from a re-read", async () => {
		const scripted = both(
			[[PULL, served(pull())]],
			[
				[graphql(), openBotThread],
				[graphql(), replied],
				[graphql(), resolvedOk],
				[graphql(), resolvedWithRationale],
			],
		);
		const out = await scripted.outcome;
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`resolved\tPRRT_kwDOLxx1\t${URL}\n`);
		expect(scripted.seams.bodies[2]).toContain("addPullRequestReviewThreadReply");
		expect(scripted.seams.bodies[3]).toContain("resolveReviewThread");
	});

	it("refuses a thread with any non-Bot author on 16 — a human objection is theirs", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[
					graphql(),
					served(
						threadPage(1, [
							{
								id: "PRRT_kwDOLxx1",
								comments: [{login: "cansirin", typename: "User", body: "no"}],
							},
						]),
					),
				],
			],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("is not positively bot-classed (author cansirin is User)");
	});

	it("refuses an already-resolved thread on 16", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[
					graphql(),
					served(
						threadPage(1, [
							{id: "PRRT_kwDOLxx1", isResolved: true, comments: [{...bot, body: "x"}]},
						]),
					),
				],
			],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("is already resolved");
	});

	it("refuses a thread absent from the PR on 7", async () => {
		const out = await run([[PULL, served(pull())]], [[graphql(), served(threadPage(0, []))]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("refuses an empty rationale on 3 — a silent resolve is unauditable", async () => {
		const out = await run([[PULL, served(pull())]], [], {
			stdin: Effect.succeed({_tag: "Text", text: "   "} as StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toContain("write why");
	});

	it("refuses a machine-local path in the rationale on 5", async () => {
		const out = await run([[PULL, served(pull())]], [], {
			stdin: Effect.succeed({_tag: "Text", text: "see /Users/someone/notes.md"} as StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.at(-1)).toContain("cite it repo-relative");
	});

	it("refuses a bare @ reference on 6 — the bytes never arrived", async () => {
		const out = await run([[PULL, served(pull())]], [], {
			stdin: Effect.succeed({_tag: "Text", text: "@notes/rationale.md"} as StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses on 8 when the reply itself fails — UNKNOWN what landed", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[graphql(), openBotThread],
				[graphql(), badGateway],
			],
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("UNKNOWN what landed");
	});

	it("refuses on 9 when the write landed and the read-back does not show it resolved", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[graphql(), openBotThread],
				[graphql(), replied],
				[graphql(), resolvedOk],
				[graphql(), openBotThread],
			],
		);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("does not show PRRT_kwDOLxx1 resolved");
	});
});
