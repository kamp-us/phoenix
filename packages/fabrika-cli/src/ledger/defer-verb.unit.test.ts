/**
 * `ledger defer` — two legs and a proof, and the close endpoint that is never among them.
 *
 * The scripts here declare no `PATCH .../issues/4288` route at all, so an attempt to close would be
 * an unscripted call rather than a silently satisfied one: the fake refuses what it was not told
 * about, which is what makes "never closes" a fact this suite can hold rather than an intention.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {
	BARE_AT_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runDefer} from "./defer-verb.ts";
import {CLAIMED, childIssue, env, epic, subIssues, TOKEN} from "./fixtures.test-support.ts";

const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4288$/;
const EPIC_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const COMMENT = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4288\/comments$/;
const UNLINK = /^DELETE https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issue$/;

const COMMENTED = served(
	{id: 5230661234, html_url: "https://forge.example/o/r/issues/4288#c"},
	201,
);

const REASON = "deferred to a follow-up cycle by founder ruling";

const happy = (
	overrides: {
		comment?: HttpReply;
		unlink?: HttpReply;
		after?: HttpReply;
		afterSubs?: HttpReply;
	} = {},
): ReadonlyArray<Scripted> => [
	[EPIC_READ, epic()],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
	[once(SUBS), subIssues({number: 4288, id: 42880})],
	[once(CHILD), childIssue({number: 4288})],
	[COMMENT, overrides.comment ?? COMMENTED],
	[UNLINK, overrides.unlink ?? served({})],
	[CHILD, overrides.after ?? childIssue({number: 4288})],
	[SUBS, overrides.afterSubs ?? served([])],
];

const run = (
	script: ReadonlyArray<Scripted> = happy(),
	options: {child?: number; reason?: string} = {},
) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({files: {}});
	return Effect.runPromise(
		Effect.provide(
			runDefer({
				number: 4300,
				child: options.child ?? 4288,
				reason: options.reason ?? REASON,
				token: TOKEN,
				repo: null,
				cwd: "/repo",
				env,
			}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({
		outcome,
		log: shell.log,
		bodies: shell.bodies,
		requests: shell.requests,
	}));
};

describe("runDefer", () => {
	it("comments, unlinks, and proves the child still open", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "deferred",
			epic: 4300,
			child: 4288,
			comment: 5230661234,
			unlinked: true,
			state: "open",
		});
	});

	it("issues no close call at all — the follow-up survives the deferral", async () => {
		const {requests} = await run();
		expect(requests.some((line) => line.startsWith("PATCH"))).toBe(false);
	});

	it("journals before it unlinks, so the reason survives a failed unlink", async () => {
		const {log} = await run();
		const order = log.filter((line) => COMMENT.test(line) || UNLINK.test(line));
		expect(order.map((line) => (COMMENT.test(line) ? "comment" : "unlink"))).toEqual([
			"comment",
			"unlink",
		]);
	});

	it("says in the comment that the issue stays open", async () => {
		const {requests, bodies} = await run();
		const at = requests.findIndex((line) => COMMENT.test(line));
		expect(JSON.parse(bodies[at] ?? "null").body).toContain("stays open as the follow-up");
	});

	it("unlinks on the child's id, not its number", async () => {
		const {requests, bodies} = await run();
		const at = requests.findIndex((line) => UNLINK.test(line));
		expect(JSON.parse(bodies[at] ?? "null")).toEqual({sub_issue_id: 42880});
	});

	it("refuses a child that is not this epic's sub-issue", async () => {
		const {outcome, requests} = await run([
			[EPIC_READ, epic()],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			...CLAIMED,
			[SUBS, subIssues({number: 4301, id: 43010})],
		]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(requests.some((line) => COMMENT.test(line))).toBe(false);
	});

	it("refuses a child that is already closed — a deferral keeps an OPEN follow-up", async () => {
		const {outcome, requests} = await run([
			[EPIC_READ, epic()],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			...CLAIMED,
			[SUBS, subIssues({number: 4288, id: 42880})],
			[CHILD, childIssue({number: 4288, state: "closed", stateReason: "not_planned"})],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(requests.some((line) => COMMENT.test(line))).toBe(false);
	});

	it("refuses an unreadable child rather than writing on an unknown", async () => {
		const {outcome, requests} = await run([
			[EPIC_READ, epic()],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			...CLAIMED,
			[SUBS, subIssues({number: 4288, id: 42880})],
			[CHILD, {status: 502, body: ""}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.some((line) => COMMENT.test(line))).toBe(false);
	});

	it("refuses a reason that says nothing", async () => {
		const {outcome, requests} = await run(happy(), {reason: "   "});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(requests.some((line) => COMMENT.test(line))).toBe(false);
	});

	it("refuses a reason carrying a bare @ reference", async () => {
		const {outcome} = await run(happy(), {reason: "@notes/plan.md is the record"});
		expect(outcome.code).toBe(BARE_AT_PATH);
	});

	it("reports UNKNOWN when the unlink cannot be proven, naming the legs it wrote", async () => {
		const {outcome} = await run(happy({unlink: {status: 502, body: ""}}));
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("wrote 1 of 2 legs");
	});

	it("refuses when the child reads back still linked", async () => {
		const {outcome} = await run(happy({afterSubs: served([{number: 4288, id: 42880}])}));
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses when the child reads back closed — that write was nobody's here", async () => {
		const {outcome} = await run(
			happy({after: childIssue({number: 4288, state: "closed", stateReason: "completed"})}),
		);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
