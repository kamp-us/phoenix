import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {
	AUDIENCE_NOT_AGENT,
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	OUT_OF_FOCUS,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	candidates,
	comments,
	focusTable,
	issue,
	LANE_UUID,
	marker,
	truncatedComments,
} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";
import {DEFAULT_ROADMAP} from "./scope-admission.ts";

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

const labelled = (...names: ReadonlyArray<string>) => names.map((name) => ({name}));

/** The claim path's default target: triaged, agent-ready, unhomed — admitted under an inert fence. */
const CLAIMABLE = issue({labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent")});

/** No `ROADMAP.md`: no focus declared, so the scope axis admits and the fence reports itself inert. */
const NO_FOCUS = fakeFs({files: {}});

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	uuid: LANE_UUID,
	at: "2026-08-09T00:00:00Z",
	override: null as string | null,
};

const run = (
	verb: typeof runClaim,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	fs = NO_FOCUS,
) =>
	Effect.runPromise(
		Effect.provide(
			verb({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	);

describe("runClaim", () => {
	it("wins when its own marker is the earliest authorized one", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
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
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		const posted = shell.calls.findIndex((line) => POST.test(line));
		const swept = shell.calls.findIndex((line) => COMMENTS.test(line));
		expect(posted).toBeGreaterThanOrEqual(0);
		expect(swept).toBeGreaterThan(posted);
	});

	it("exits 15 on a lost race — NEVER 0 — names the winner and retracts its own marker", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
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
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
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
			[ISSUE, CLAIMABLE],
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
			[ISSUE, CLAIMABLE],
			[POST, errOut("gh: Gateway timeout (HTTP 504)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(
			'run "fabrika build confirm 4312" before any further action',
		);
	});

	it("refuses a marker that does not read back on 9", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, okOut(JSON.stringify({body: "something else"}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses an unreadable marker set on 11 — never 'unclaimed'", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('ownership is UNKNOWN, never "unclaimed"');
	});

	it("refuses a TRUNCATED marker read on 11 and keeps its own marker — a short read is not a loss", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("page boundary");
		expect(out.stderr.some((line) => line.includes("is not authorized"))).toBe(false);
		expect(shell.calls.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses an unreadable PERMISSION on 11 — a transient read never demotes an author", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
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

/**
 * The fence, at the seam where it has teeth.
 *
 * Every refusal below asserts on **`shell.calls`** as well as the exit code: "refuses" and "refuses
 * before writing anything" are different claims, and only the call log can tell them apart. A claim
 * that posted and then refused would leave a marker on the issue with nothing to retract it.
 */
describe("runClaim — the admission test runs before any marker is written", () => {
	const FOCUSED = fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}});

	const claimWith = (target: ExecResult, fs = FOCUSED, overrides: Partial<typeof options> = {}) => {
		const shell = fakeShell([
			[ISSUE, target],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		return Effect.runPromise(
			Effect.provide(runClaim({...options, ...overrides}), Layer.merge(shell.layer, fs.layer)),
		).then((out) => ({out, shell}));
	};

	const OUT_OF_CAMPAIGN = issue({
		milestone: {number: 39},
		labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent"),
	});
	const HUMAN_AUDIENCE = issue({
		milestone: {number: 44},
		labels: labelled("type:bug", "p1", "status:triaged", "ready-for:human"),
	});

	it("refuses an out-of-focus issue on 20, and posts NOTHING", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN);
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("out of focus"))).toBe(true);
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("refuses a non-agent audience on 21 — a sibling axis, never folded into 20", async () => {
		const {out, shell} = await claimWith(HUMAN_AUDIENCE);
		expect(out.code).toBe(AUDIENCE_NOT_AGENT);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("ready-for:human"))).toBe(true);
	});

	it("refuses an unreadable declaration on 11 — scope is UNKNOWN, never admitted", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[DEFAULT_ROADMAP]: null}, unprobeable: [DEFAULT_ROADMAP]}),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.at(-1)).toContain("scope is UNKNOWN, never admitted; nothing was written");
	});

	it("refuses a malformed declaration on 4 — never read as 'no focus'", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44).replace("2026-08-09", "the 9th")}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("claims a refused issue under --override, recording the reason on the marker and in the answer", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {
			override: "hotfix for the release blocker",
		});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			number: 4312,
			token: `build:s-9f2e:${LANE_UUID}`,
			override: "hotfix for the release blocker",
		});
		expect(
			shell.calls.some(
				(line) =>
					POST.test(line) && line.includes("build-claim-override: hotfix for the release blocker"),
			),
		).toBe(true);
	});

	it("never lets --override past an UNKNOWN admission — a failed read has proven nothing", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[DEFAULT_ROADMAP]: null}, unprobeable: [DEFAULT_ROADMAP]}),
			{override: "I know what I am doing"},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an empty --override reason on 1 — an override is recorded or it is not one", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {override: "  "});
		expect(out.code).toBe(FAILED);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("names the declaration it judged against on a win, so an inert-fence claim reads as one", async () => {
		const {out} = await claimWith(
			issue({milestone: {number: 44}, labels: labelled("status:triaged", "ready-for:agent")}),
		);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("build claim: focus: milestone #44, declared 2026-08-09.");
	});

	it("refuses by NUMBER the very issue the pool excluded — the direct handoff is fenced too", async () => {
		const row = {
			number: 4312,
			labels: ["status:triaged", "ready-for:agent", "type:bug"],
			milestone: 39,
		};
		const picked = await Effect.runPromise(
			Effect.provide(
				runPick({repo: null, limit: 20, env: options.env}),
				Layer.merge(
					fakeShell([
						[/labels=status%3Atriaged%2Cp0/, candidates(row)],
						[/labels=status%3Atriaged%2Cp[12]/, okOut("[]")],
					]).layer,
					FOCUSED.layer,
				),
			),
		);
		expect(JSON.parse(picked.stdout).pool).toEqual([]);
		expect(JSON.parse(picked.stdout).excluded).toEqual([
			{number: 4312, home: "39", reason: "out-of-focus"},
		]);

		// The same issue, handed straight to `claim` by number: the pool was bypassed, the fence is not.
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN);
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("leaves confirm and release outside the fence — a mid-lane focus edit strands no lane", async () => {
		const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
			[ISSUE, OUT_OF_CAMPAIGN],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		];
		const confirmed = await run(runConfirm, script, {}, FOCUSED);
		expect(confirmed.code).toBe(0);
		const released = await run(runRelease, script, {}, FOCUSED);
		expect(released.code).toBe(0);
	});
});

describe("runConfirm", () => {
	it("answers mine when this session holds the earliest authorized marker", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("mine");
	});

	it("refuses a foreign holder on 15, naming the token", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
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
			[ISSUE, CLAIMABLE],
			[COMMENTS, okOut("[]")],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			'build confirm: no claim exists on #4312 — nothing to confirm; run "fabrika build claim 4312" first.',
		);
	});

	it("refuses a truncated read on 11, never as the 'no claim exists' it looks like", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("page boundary");
	});
});

describe("runRelease", () => {
	it("retracts this session's OWN marker and nothing else", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "released", number: 4312});
		expect(shell.calls.filter((line) => DELETE.test(line))).toEqual([
			"gh api --method DELETE repos/o/r/issues/comments/9001",
		]);
	});

	it("refuses to release another lane's claim on 15, and deletes nothing", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), okOut("write\n")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			"build release: this session holds no claim on #4312 — refusing to release another lane's.",
		);
		expect(shell.calls.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses a truncated read on 11 and deletes nothing", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses a failed retraction on 8 — whether the claim is still held is UNKNOWN", async () => {
		const out = await run(runRelease, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
			[once(DELETE), errOut("gh: Gateway timeout (HTTP 504)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
	});
});
