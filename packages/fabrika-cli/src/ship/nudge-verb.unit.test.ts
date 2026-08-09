import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	NUDGE_REOPEN_UNCONFIRMED,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	STALE_HEAD,
} from "./codes.ts";
import {
	checkRuns,
	ENV,
	HEAD,
	OTHER_HEAD,
	pull,
	timeline,
	unexhaustedPage,
	workflows,
} from "./fixtures.test-support.ts";
import {runNudge} from "./nudge-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const STATUS = /^gh api repos\/o\/r\/commits\/[0-9a-f]+\/status$/;
const WORKFLOWS = /^gh api --paginate repos\/o\/r\/actions\/workflows/;
const COMMIT_DATE = /^gh api repos\/o\/r\/commits\/[0-9a-f]+ --jq \.commit\.committer\.date$/;
const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;
const CLOSE = /^gh api --method PATCH repos\/o\/r\/pulls\/4321 -f state=closed$/;
const REOPEN = /^gh api --method PATCH repos\/o\/r\/pulls\/4321 -f state=open$/;

const PUSHED = "2026-08-08T09:00:00Z";
const statusTotal = (total: number): ExecResult => okOut(JSON.stringify({total_count: total}));

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(runNudge(options), fakeShell(script).layer));

const preconditionsMet: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[RUNS, checkRuns(0, [])],
	[STATUS, statusTotal(0)],
	[WORKFLOWS, workflows("active", "active")],
	[COMMIT_DATE, okOut(PUSHED)],
	[TIMELINE, timeline()],
];

describe("runNudge", () => {
	it("closes, verifies, reopens and verifies — both legs read back", async () => {
		const shell = fakeShell([
			[once(PULL), pull()],
			...preconditionsMet,
			[CLOSE, okOut("")],
			[once(PULL), pull({state: "closed"})],
			[REOPEN, okOut("")],
			[PULL, pull()],
		]);
		const out = await Effect.runPromise(Effect.provide(runNudge(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`nudged\t${HEAD}\n`);
	});

	it("refuses on 16 when runs already exist at the head — it re-derives, it does not trust (#4816)", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[RUNS, checkRuns(14, [])],
		]);
		const out = await Effect.runPromise(Effect.provide(runNudge(options), shell.layer));
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toBe(
			`ship nudge: #4321 is not in the dropped-trigger state (14 check runs exist at ${HEAD}) — refusing to touch it (#4816).`,
		);
		expect(shell.calls.some((line) => line.includes("--method PATCH"))).toBe(false);
	});

	it("refuses on 16 when a commit status exists even though check runs do not", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, checkRuns(0, [])],
			[STATUS, statusTotal(3)],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("3 commit statuses exist");
	});

	it("refuses on 16 when the repository declares no workflows at all", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, checkRuns(0, [])],
			[STATUS, statusTotal(0)],
			[WORKFLOWS, workflows()],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("declares no workflows");
	});

	it("refuses a second nudge on the same head on 16 — escalation, not retry", async () => {
		const out = await run([
			[PULL, pull()],
			[RUNS, checkRuns(0, [])],
			[STATUS, statusTotal(0)],
			[WORKFLOWS, workflows("active")],
			[COMMIT_DATE, okOut(PUSHED)],
			[TIMELINE, timeline({event: "reopened", at: "2026-08-08T09:30:00Z"})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("was already nudged (1 reopened events since push)");
	});

	it("refuses a moved head on 12 — the state diagnosed is another tree's", async () => {
		const out = await run([[PULL, pull({head: OTHER_HEAD})]]);
		expect(out.code).toBe(STALE_HEAD);
	});

	it("refuses an unreadable precondition on 11 without touching the PR", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[RUNS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		const out = await Effect.runPromise(Effect.provide(runNudge(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => line.includes("--method PATCH"))).toBe(false);
	});

	it("returns 17 — the loudest code — when the close landed and the reopen is unconfirmed", async () => {
		const out = await run([
			[once(PULL), pull()],
			...preconditionsMet,
			[CLOSE, okOut("")],
			[once(PULL), pull({state: "closed"})],
			[REOPEN, errOut("gh: Bad gateway (HTTP 502)")],
			[PULL, pull({state: "closed"})],
		]);
		expect(out.code).toBe(NUDGE_REOPEN_UNCONFIRMED);
		expect(out.stderr.at(-1)).toContain("PR #4321 may be CLOSED. Reopen it by hand now.");
	});

	it("refuses an unexhausted timeline on 13 — an undercounted history licenses a second nudge", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			...preconditionsMet.filter(([pattern]) => pattern !== TIMELINE),
			[TIMELINE, unexhaustedPage()],
		]);
		const out = await Effect.runPromise(Effect.provide(runNudge(options), shell.layer));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toBe(
			"ship nudge: the timeline read never reached a terminal page — pagination is unexhausted; refusing to count reopens over a truncated history.",
		);
		expect(shell.calls.some((line) => line.includes("--method PATCH"))).toBe(false);
	});
});
