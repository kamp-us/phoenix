import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {ENV, pull, threadPage} from "./fixtures.test-support.ts";
import {runThreads} from "./threads-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
/** The thread enumeration is the GraphQL carve. */
const GRAPHQL = /^POST https:\/\/api\.github\.com\/graphql$/;

/** The PR read, served — the same canned payload the spawner era scripted. */
const PR: HttpReply = {status: 200, body: pull().stdout};

/** One served thread page, as the endpoint answers it. */
const threads = (declared: number, nodes: Parameters<typeof threadPage>[1]): HttpReply => ({
	status: 200,
	body: threadPage(declared, nodes).stdout,
});

const options = {pr: 4321, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runThreads({...options, ...overrides}), fakeSeams([...script, ...http]).layer),
	);

const bot = {login: "github-advanced-security", typename: "Bot"};
const human = {login: "cansirin", typename: "User"};

describe("runThreads", () => {
	it("prints a proven zero rather than an empty answer", async () => {
		const out = await run([[PULL, PR]], [[GRAPHQL, threads(0, [])]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("threads\t0\n");
	});

	it("classes a thread bot only when EVERY author is a Bot", async () => {
		const out = await run(
			[[PULL, PR]],
			[
				[
					GRAPHQL,
					threads(1, [
						{
							id: "PRRT_kwDOLxx1",
							path: "src/cart.ts",
							line: 14,
							comments: [{...bot, body: "Unused import: `Effect` is imported but never used."}],
						},
					]),
				],
			],
		);
		expect(out.stdout).toBe(
			[
				"threads\t1",
				"thread\tPRRT_kwDOLxx1\tbot\tsrc/cart.ts:14\tgithub-advanced-security\tUnused import: `Effect` is imported but never used.",
				"",
			].join("\n"),
		);
	});

	it("classes a bot thread HUMAN once a human replies — v1's first-comment-only hole", async () => {
		const out = await run(
			[[PULL, PR]],
			[
				[
					GRAPHQL,
					threads(1, [
						{
							id: "PRRT_kwDOLxx1",
							path: "src/cart.ts",
							line: 14,
							comments: [
								{...bot, body: "unused import"},
								{...human, body: "no, this matters"},
							],
						},
					]),
				],
			],
		);
		expect(out.stdout).toContain("\thuman\t");
	});

	it("classes an unrecognised author type as human by construction, never by enumeration", async () => {
		const out = await run(
			[[PULL, PR]],
			[
				[
					GRAPHQL,
					threads(1, [{id: "T1", comments: [{login: "ghost", typename: "Mannequin", body: "x"}]}]),
				],
			],
		);
		expect(out.stdout).toContain("\thuman\tpr-level\t");
	});

	it("omits resolved threads from the count without dropping them from the scan", async () => {
		const out = await run(
			[[PULL, PR]],
			[
				[
					GRAPHQL,
					threads(2, [
						{id: "T1", isResolved: true, comments: [{...bot, body: "x"}]},
						{id: "T2", comments: [{...human, body: "y"}]},
					]),
				],
			],
		);
		expect(out.stdout.split("\n")[0]).toBe("threads\t1");
		expect(out.stderr).toContain("ship threads: scanned 2 threads; 2 declared.");
	});

	it("refuses a short thread enumeration on 13", async () => {
		const out = await run(
			[[PULL, PR]],
			[[GRAPHQL, threads(9, [{id: "T1", comments: [{...bot, body: "x"}]}])]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses a short COMMENT enumeration on 13 — the second pagination layer", async () => {
		const out = await run(
			[[PULL, PR]],
			[[GRAPHQL, threads(1, [{id: "T1", declaredComments: 4, comments: [{...bot, body: "x"}]}])]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("of 4 comments on thread T1");
	});

	it("refuses an unreadable payload on 11 — UNKNOWN, never zero", async () => {
		const out = await run(
			[[PULL, PR]],
			[[GRAPHQL, {status: 502, body: '{"message":"Bad gateway"}'}]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN, never zero");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
