import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, linkNext, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	NUDGE_REOPEN_UNCONFIRMED,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	STALE_HEAD,
} from "./codes.ts";
import {checkRuns, ENV, HEAD, OTHER_HEAD, pull, workflows} from "./fixtures.test-support.ts";
import {runNudge} from "./nudge-verb.ts";

/** The live-head read is `../io/pulls.ts`'s, served over HTTP like every other leg. */
const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;

const RUNS = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const STATUS = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+\/status$/;
const WORKFLOWS = /^GET \S+\/repos\/o\/r\/actions\/workflows\?/;
const COMMIT_DATE = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+$/;
const TIMELINE = /^GET \S+\/repos\/o\/r\/issues\/4321\/timeline\?/;
/** Close and reopen are the same endpoint and method — `once` is what tells the two legs apart. */
const PATCH_PULL = /^PATCH \S+\/repos\/o\/r\/pulls\/4321$/;

const PUSHED = "2026-08-08T09:00:00Z";

const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});
const badGateway: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};
const statusTotal = (total: number): HttpReply => ({
	status: 200,
	body: JSON.stringify({total_count: total}),
});
const commitDate = (date: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({commit: {committer: {date}}}),
});
const timeline = (...rows: ReadonlyArray<{event: string; at: string}>): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows.map((row) => ({event: row.event, created_at: row.at}))),
});
/** The same page, but declaring a `next` — the read that can never prove it is complete. */
const unexhaustedPage = (): HttpReply => ({
	status: 200,
	body: "[]",
	headers: linkNext("https://api.github.com/repos/o/r/issues/4321/timeline?page=2"),
});

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const both = (rows: ReadonlyArray<Scripted>, http: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams([...rows, ...http]);
	return {
		seams,
		outcome: Effect.runPromise(Effect.provide(runNudge(options), seams.layer)),
	};
};

const run = (rows: ReadonlyArray<Scripted>, http: ReadonlyArray<Scripted>) =>
	both(rows, http).outcome;

const preconditionsMet: ReadonlyArray<readonly [RegExp, HttpReply]> = [
	[RUNS, served(checkRuns(0, []))],
	[STATUS, statusTotal(0)],
	[WORKFLOWS, served(workflows("active", "active"))],
	[COMMIT_DATE, commitDate(PUSHED)],
	[TIMELINE, timeline()],
];

describe("runNudge", () => {
	it("closes, verifies, reopens and verifies — both legs read back", async () => {
		const out = await run(
			[
				[once(PULL), served(pull())],
				[once(PULL), served(pull({state: "closed"}))],
				[PULL, served(pull())],
			],
			[...preconditionsMet, [PATCH_PULL, {status: 200, body: "{}"}]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`nudged\t${HEAD}\n`);
	});

	it("refuses on 16 when runs already exist at the head — it re-derives, it does not trust (#4816)", async () => {
		const scripted = both([[PULL, served(pull())]], [[RUNS, served(checkRuns(14, []))]]);
		const out = await scripted.outcome;
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toBe(
			`ship nudge: #4321 is not in the dropped-trigger state (14 check runs exist at ${HEAD}) — refusing to touch it (#4816).`,
		);
		expect(scripted.seams.requests.some((line) => line.startsWith("PATCH"))).toBe(false);
	});

	it("refuses on 16 when a commit status exists even though check runs do not", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[RUNS, served(checkRuns(0, []))],
				[STATUS, statusTotal(3)],
			],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("3 commit statuses exist");
	});

	it("refuses on 16 when the repository declares no workflows at all", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[RUNS, served(checkRuns(0, []))],
				[STATUS, statusTotal(0)],
				[WORKFLOWS, served(workflows())],
			],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("declares no workflows");
	});

	it("refuses a second nudge on the same head on 16 — escalation, not retry", async () => {
		const out = await run(
			[[PULL, served(pull())]],
			[
				[RUNS, served(checkRuns(0, []))],
				[STATUS, statusTotal(0)],
				[WORKFLOWS, served(workflows("active"))],
				[COMMIT_DATE, commitDate(PUSHED)],
				[TIMELINE, timeline({event: "reopened", at: "2026-08-08T09:30:00Z"})],
			],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("was already nudged (1 reopened events since push)");
	});

	it("refuses a moved head on 12 — the state diagnosed is another tree's", async () => {
		const out = await run([[PULL, served(pull({head: OTHER_HEAD}))]], []);
		expect(out.code).toBe(STALE_HEAD);
	});

	it("refuses an unreadable precondition on 11 without touching the PR", async () => {
		const scripted = both([[PULL, served(pull())]], [[RUNS, badGateway]]);
		const out = await scripted.outcome;
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(scripted.seams.requests.some((line) => line.startsWith("PATCH"))).toBe(false);
	});

	it("returns 17 — the loudest code — when the close landed and the reopen is unconfirmed", async () => {
		const out = await run(
			[
				[once(PULL), served(pull())],
				[PULL, served(pull({state: "closed"}))],
			],
			[
				...preconditionsMet,
				[once(PATCH_PULL), {status: 200, body: "{}"}],
				[PATCH_PULL, badGateway],
			],
		);
		expect(out.code).toBe(NUDGE_REOPEN_UNCONFIRMED);
		expect(out.stderr.at(-1)).toContain("PR #4321 may be CLOSED. Reopen it by hand now.");
	});

	it("refuses an unexhausted timeline on 13 — an undercounted history licenses a second nudge", async () => {
		const scripted = both(
			[[PULL, served(pull())]],
			[
				...preconditionsMet.filter(([pattern]) => pattern !== TIMELINE),
				[TIMELINE, unexhaustedPage()],
			],
		);
		const out = await scripted.outcome;
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toBe(
			"ship nudge: the timeline read never reached a terminal page — pagination is unexhausted; refusing to count reopens over a truncated history.",
		);
		expect(scripted.seams.requests.some((line) => line.startsWith("PATCH"))).toBe(false);
	});
});
