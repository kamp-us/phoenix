import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {
	CLAIM_NOT_MINE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments, issue, LANE_UUID, marker} from "./fixtures.test-support.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/4312\/comments/;
const GET_COMMENT = /^gh api repos\/o\/r\/issues\/comments\/9001$/;
const DELETE = /^gh api --method DELETE repos\/o\/r\/issues\/comments\//;
const perm = (login: string) => new RegExp(`^gh api repos/o/r/collaborators/${login}/permission`);

const MINE = marker("s-9f2e", LANE_UUID);
const THEIRS = marker("s-77aa", "9d8c7b6a-5f4e-3d2c-1b0a-998877665544");

const POSTED = okOut(JSON.stringify({id: 9001, html_url: "https://github.com/o/r/issues/4312#c"}));
const ECHO = okOut(JSON.stringify({body: MINE}));

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	uuid: LANE_UUID,
	at: "2026-08-09T00:00:00Z",
};

const run = (
	verb: typeof runClaim,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(verb({...options, ...overrides}), fakeShell(script).layer));

describe("runClaim", () => {
	it("wins when its own marker is the earliest authorized one", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			number: 4312,
			token: `build:s-9f2e:${LANE_UUID}`,
		});
	});

	it("re-reads AFTER posting — the checkpoint is what resolves a staggered race", async () => {
		const shell = fakeShell([
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		await Effect.runPromise(Effect.provide(runClaim(options), shell.layer));
		const posted = shell.calls.findIndex((line) => POST.test(line));
		const swept = shell.calls.findIndex((line) => COMMENTS.test(line));
		expect(posted).toBeGreaterThanOrEqual(0);
		expect(swept).toBeGreaterThan(posted);
	});

	it("exits 15 on a lost race — NEVER 0 — names the winner and retracts its own marker", async () => {
		const shell = fakeShell([
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS, createdAt: "2026-08-08T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-09T00:00:00Z"},
				),
			],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runClaim(options), shell.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("lost to build:s-77aa:");
		expect(out.stderr.some((line) => line.includes("retracted this run's own marker"))).toBe(true);
		expect(
			shell.calls.some((line) => /DELETE repos\/o\/r\/issues\/comments\/9001/.test(line)),
		).toBe(true);
	});

	it("never lets marker TEXT confer authority — an unauthorized earlier marker does not win", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS, author: "drive-by", createdAt: "2026-08-08T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-09T00:00:00Z"},
				),
			],
			[perm("drive-by"), okOut("read\n")],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("who holds no write permission"))).toBe(true);
	});

	it("refuses a failed marker write on 8 — UNKNOWN, and points at confirm", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, errOut("gh: Gateway timeout (HTTP 504)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(
			'run "fabrika build confirm 4312" before any further action',
		);
	});

	it("refuses a marker that does not read back on 9", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, okOut(JSON.stringify({body: "something else"}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses an unreadable marker set on 11 — never 'unclaimed'", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('ownership is UNKNOWN, never "unclaimed"');
	});

	it("refuses an unreadable PERMISSION on 11 — a transient read never demotes an author", async () => {
		const out = await run(runClaim, [
			[ISSUE, issue()],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a missing session id on 1, NOT on 15 — the two were fused in v1", async () => {
		const out = await run(runClaim, [], {env: {CLAUDE_PIPELINE_REPO: "o/r"}});
		expect(out.code).toBe(FAILED);
	});

	it("refuses a proven-absent issue on 7", async () => {
		const out = await run(runClaim, [[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

describe("runConfirm", () => {
	it("answers mine when this session holds the earliest authorized marker", async () => {
		const out = await run(runConfirm, [
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("mine");
	});

	it("refuses a foreign holder on 15, naming the token", async () => {
		const out = await run(runConfirm, [
			[ISSUE, issue()],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			"build confirm: #4312 is held by build:s-77aa:9d8c7b6a-5f4e-3d2c-1b0a-998877665544, not this session.",
		);
	});

	it("refuses proven-unclaimed on 15 too, with the no-claim message", async () => {
		const out = await run(runConfirm, [
			[ISSUE, issue()],
			[COMMENTS, okOut("[]")],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			'build confirm: no claim exists on #4312 — nothing to confirm; run "fabrika build claim 4312" first.',
		);
	});
});

describe("runRelease", () => {
	it("retracts this session's OWN marker and nothing else", async () => {
		const shell = fakeShell([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runRelease(options), shell.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "released", number: 4312});
		expect(shell.calls.filter((line) => DELETE.test(line))).toEqual([
			"gh api --method DELETE repos/o/r/issues/comments/9001",
		]);
	});

	it("refuses to release another lane's claim on 15, and deletes nothing", async () => {
		const shell = fakeShell([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), okOut("write\n")],
		]);
		const out = await Effect.runPromise(Effect.provide(runRelease(options), shell.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			"build release: this session holds no claim on #4312 — refusing to release another lane's.",
		);
		expect(shell.calls.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses a failed retraction on 8 — whether the claim is still held is UNKNOWN", async () => {
		const out = await run(runRelease, [
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[once(DELETE), errOut("gh: Gateway timeout (HTTP 504)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
	});
});
