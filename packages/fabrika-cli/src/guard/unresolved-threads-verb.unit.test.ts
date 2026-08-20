import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {comments, ENV, pull, threadPage} from "../ship/fixtures.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runUnresolvedThreadsGuard} from "./unresolved-threads-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const GRAPHQL = /^POST https:\/\/api\.github\.com\/graphql$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const ACL = /^gh api repos\/o\/r\/collaborators\/[^ ]+\/permission/;

const write = okOut("write\n");
const readOnly = okOut("read\n");

const options = {pr: 4321, repo: null, env: ENV};

/** The one sanctioned GraphQL read, served: `threadPage`'s payload as the endpoint answers it. */
const served = (page: ExecResult): HttpReply => ({status: 200, body: page.stdout});

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			runUnresolvedThreadsGuard({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeHttp(http).layer),
		),
	);

const SITE = ".github/workflows/commands-guard.yml:35";

/** The #3329 exemplar thread: an unresolved GHAS finding on the commands-guard workflow. */
const codeqlPage = (isResolved = false): HttpReply =>
	served(
		threadPage(1, [
			{
				id: "PRRT_kwDOCodeQL",
				isResolved,
				path: ".github/workflows/commands-guard.yml",
				line: 35,
				comments: [
					{
						login: "github-advanced-security",
						typename: "Bot",
						body: "Workflow does not contain permissions",
					},
				],
			},
		]),
	);

const PASS_NO_ACCOUNTING =
	"review-code: PASS @ 4da28749abc0000000000000000000000000000 — AC met, merge-ready";
const PASS_ACCOUNTED = `review-code: PASS @ 4da28749abc0000000000000000000000000000 — merge-ready\n- [FAIL] unresolved-threads — ${SITE} @github-advanced-security: substantive (ADR 0158)`;

describe("runUnresolvedThreadsGuard", () => {
	it("REDS the #3329 shape: a live thread the authorized PASS never names", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: PASS_NO_ACCOUNTING, author: "reviewer"})],
				[ACL, write],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(VIOLATION);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(SITE);
	});

	it("passes when the authorized verdict names the site — polarity-blind", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: PASS_ACCOUNTED, author: "reviewer"})],
				[ACL, write],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("all accounted-for");
	});

	it("passes on zero review threads without reading the ACL at all", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[COMMENTS, comments()],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runUnresolvedThreadsGuard(options),
				Layer.merge(shell.layer, fakeHttp([[GRAPHQL, served(threadPage(0, []))]]).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("no review threads");
		expect(shell.calls.some((line) => ACL.test(line))).toBe(false);
	});

	it("passes when the only thread is resolved", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
			],
			{},
			[[GRAPHQL, codeqlPage(true)]],
		);
		expect(out.code).toBe(0);
	});

	it("REDS when the verdict's author holds no write+ permission — a forged marker accounts for nothing", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: PASS_ACCOUNTED, author: "drive-by"})],
				[ACL, readOnly],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(VIOLATION);
		expect(out.stderr.join("\n")).toContain("no authorized review-code verdict");
	});

	it("REDS when the ACL itself is unreadable — the marker is dropped, never trusted", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: PASS_ACCOUNTED, author: "reviewer"})],
				[ACL, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(VIOLATION);
	});

	it("takes the newest write stamp, so a re-written FAIL outranks an older accounting PASS", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 2})],
				[
					COMMENTS,
					comments(
						{id: 1, body: PASS_ACCOUNTED, author: "reviewer", updatedAt: "2026-08-08T00:00:00Z"},
						{
							id: 2,
							body: PASS_NO_ACCOUNTING,
							author: "reviewer",
							updatedAt: "2026-08-09T00:00:00Z",
						},
					),
				],
				[ACL, write],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(VIOLATION);
	});

	it("ignores another gate's verdict — a review-doc PASS accounts for nothing", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[
					COMMENTS,
					comments({
						id: 1,
						body: `review-doc: PASS @ 4da28749abc0000000000000000000000000000 — ${SITE} is fine`,
						author: "reviewer",
					}),
				],
				[ACL, write],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(VIOLATION);
	});

	it("is UNKNOWN, never clean, when the thread read fails", async () => {
		const out = await run([[PULL, pull()]], {}, [
			[GRAPHQL, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("is UNKNOWN when the thread page arrives short of what it declared", async () => {
		const out = await run([[PULL, pull()]], {}, [[GRAPHQL, served(threadPage(4, []))]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("received 0 of 4");
	});

	it("is UNKNOWN when the comment read fails — the verdict may be in what never arrived", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("is UNKNOWN when the comment sweep is short of the platform's own count", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 5})],
				[COMMENTS, comments({id: 1, body: PASS_ACCOUNTED, author: "reviewer"})],
				[ACL, write],
			],
			{},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("is UNKNOWN when the PR read fails, and ZERO SCOPE when the PR is proven absent", async () => {
		const unreadable = await run([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(unreadable.code).toBe(PRECONDITION_UNKNOWN);
		const missing = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(missing.code).toBe(ZERO_SCOPE);
	});

	it("refuses a non-PR number as usage, not as a verdict", async () => {
		const out = await run([], {pr: 0});
		expect(out.code).toBe(1);
	});

	it("emits an ::error annotation at the thread's line under Actions", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: PASS_NO_ACCOUNTING, author: "reviewer"})],
				[ACL, write],
			],
			{env: {...ENV, GITHUB_ACTIONS: "true"}},
			[[GRAPHQL, codeqlPage()]],
		);
		expect(out.stderr.some((line) => line.startsWith("::error file="))).toBe(true);
		expect(out.stderr.join("\n")).toContain(
			"::error file=.github/workflows/commands-guard.yml,line=35::",
		);
	});
});
