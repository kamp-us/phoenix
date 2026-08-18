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
	OFF_VOCABULARY,
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
/** A second marker of the SAME session — what a pre-fix thread carries, and what release must sweep. */
const SECOND_MINE = marker("s-9f2e", "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9");

const POSTED = okOut(JSON.stringify({id: 9001, html_url: "https://github.com/o/r/issues/4312#c"}));
const ECHO = okOut(JSON.stringify({body: MINE}));

const labelled = (...names: ReadonlyArray<string>) => names.map((name) => ({name}));

/** The claim path's default target: triaged, agent-ready, unhomed — admitted under an inert fence. */
const CLAIMABLE = issue({labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent")});

/**
 * The read `claim` makes BEFORE it posts: this thread carries no marker of this session yet.
 *
 * A fresh `once` per call, because the same run then re-reads the thread at the checkpoint and must
 * see the post-state — one script entry cannot answer both reads.
 */
const unclaimed = () => [once(COMMENTS), comments()] as const;

/**
 * The thread as it reads at each successive comment list, in call order — the last state answers
 * every read after it. The protocol reads the thread several times in one run, and a static entry
 * cannot tell a pre-post read from the checkpoint that follows it.
 */
const thread = (...states: ReadonlyArray<ExecResult>) =>
	states.map((state, i) =>
		i === states.length - 1 ? ([COMMENTS, state] as const) : ([once(COMMENTS), state] as const),
	);

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
	purpose: "build",
	override: null as string | null,
	overrideLane: null as string | null,
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
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			number: 4312,
			purpose: "build",
			token: `build:s-9f2e:${LANE_UUID}`,
		});
	});

	it("re-reads AFTER posting — the checkpoint is what resolves a staggered race", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		const posted = shell.calls.findIndex((line) => POST.test(line));
		const swept = shell.calls.findLastIndex((line) => COMMENTS.test(line));
		expect(posted).toBeGreaterThanOrEqual(0);
		expect(swept).toBeGreaterThan(posted);
	});

	it("exits 15 on a lost race — NEVER 0 — names the winner and retracts its own marker", async () => {
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			unclaimed(),
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
			unclaimed(),
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
			unclaimed(),
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
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, okOut(JSON.stringify({body: "something else"}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses an unreadable marker set on 11 — never 'unclaimed'", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
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
			unclaimed(),
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
			unclaimed(),
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
			unclaimed(),
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

	it("claims an issue homed in the SECOND declared milestone, off the same predicate (#6005)", async () => {
		const {out} = await claimWith(
			OUT_OF_CAMPAIGN,
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable([44, 39])}}),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
		expect(out.stderr.some((line) => line.includes("2 milestones"))).toBe(true);
	});

	it("refuses an out-of-focus issue naming the whole declared set in the remedy", async () => {
		const {out} = await claimWith(
			OUT_OF_CAMPAIGN,
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable([44, 46])}}),
		);
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(out.stderr.some((line) => line.includes("milestones #44, #46"))).toBe(true);
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

	it("claims a refused issue under --override, recording the lane and reason on the marker and in the answer", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {
			override: "hotfix for the release blocker",
			overrideLane: "build-ui",
		});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			number: 4312,
			purpose: "build",
			token: `build:s-9f2e:${LANE_UUID}`,
			override: {lane: "build-ui", reason: "hotfix for the release blocker"},
		});
		expect(
			shell.calls.some(
				(line) =>
					POST.test(line) &&
					line.includes("build-claim-override: build-ui · hotfix for the release blocker"),
			),
		).toBe(true);
	});

	it("never lets --override past an UNKNOWN admission — a failed read has proven nothing", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[DEFAULT_ROADMAP]: null}, unprobeable: [DEFAULT_ROADMAP]}),
			{override: "I know what I am doing", overrideLane: "build-ui"},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an empty --override reason on 1 — an override is recorded or it is not one", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {
			override: "  ",
			overrideLane: "build-ui",
		});
		expect(out.code).toBe(FAILED);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an --override that names no lane on 1 — the escape hatch says who took it (#5175)", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {
			override: "hotfix for the release blocker",
		});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.some((line) => line.includes("--override-lane"))).toBe(true);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses a blank --override-lane on 1 — whitespace names no lane", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, FOCUSED, {
			override: "hotfix for the release blocker",
			overrideLane: "   ",
		});
		expect(out.code).toBe(FAILED);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an --override-lane with no --override on 1 — a lane names no override alone", async () => {
		const {out, shell} = await claimWith(CLAIMABLE, FOCUSED, {overrideLane: "build-ui"});
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

/**
 * Repair claims a PR number, and a PR carries no milestone and no `ready-for:` label of its own — so
 * while any focus was declared the fence refused every one of them (#5562). The subject the two axes
 * read is the issue the PR's lane serves.
 */
describe("runClaim — a PR number is judged by the issue it serves", () => {
	const FOCUSED = fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}});
	const SERVED = /^gh api repos\/o\/r\/issues\/5553$/;

	const pull = (body: string) =>
		issue({
			title: "fix(build): the repair lane",
			body,
			labels: [],
			milestone: null,
			pull_request: {url: "https://api.github.com/repos/o/r/pulls/4312"},
		});

	const served = (
		milestone: number | null,
		labels = labelled("status:triaged", "ready-for:agent"),
	) =>
		okOut(
			JSON.stringify({
				number: 5553,
				title: "The ticket the lane serves",
				body: "## Acceptance criteria\n",
				state: "open",
				labels,
				html_url: "https://github.com/o/r/issues/5553",
				milestone: milestone === null ? null : {number: milestone},
				state_reason: null,
			}),
		);

	const claimPull = (
		body: string,
		servedRecord: ExecResult,
		overrides: Partial<typeof options> = {},
	) => {
		const shell = fakeShell([
			[ISSUE, pull(body)],
			[SERVED, servedRecord],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		return Effect.runPromise(
			Effect.provide(runClaim({...options, ...overrides}), Layer.merge(shell.layer, FOCUSED.layer)),
		).then((out) => ({out, shell}));
	};

	it("admits a PR whose served issue is in focus, with no override", async () => {
		const {out} = await claimPull("Fixes #5553\n", served(44));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
		expect(out.stderr.some((line) => line.includes("PR #4312 serves #5553 (fixes)"))).toBe(true);
	});

	it("reads Part of #<n> too — the partial-PR shape build --partial emits", async () => {
		const {out} = await claimPull("Part of #5553\n", served(44));
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("serves #5553 (part-of)"))).toBe(true);
	});

	it("still refuses at 20 when the served issue is genuinely out of focus, and posts NOTHING", async () => {
		const {out, shell} = await claimPull("Fixes #5553\n", served(39));
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("out of focus"))).toBe(true);
		expect(out.stderr.some((line) => line.includes("this issue's home is 39"))).toBe(true);
	});

	it("keeps that refusal overridable", async () => {
		const {out} = await claimPull("Fixes #5553\n", served(39), {
			override: "repairing a landed FAIL",
			overrideLane: "build",
		});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
	});

	it("refuses a PR naming no issue at 20, saying which case fired — and stays overridable", async () => {
		const body = "A conversation-authored ADR.\n\n## Deviations\nNone.\n";
		const {out, shell} = await claimPull(body, served(44));
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("no served issue"))).toBe(true);
		const overridden = await claimPull(body, served(44), {
			override: "no ticket — the ADR was authored in conversation",
			overrideLane: "build",
		});
		expect(overridden.out.code).toBe(0);
	});

	it("refuses at 20 when the named issue is proven absent — never on the PR's own empty home", async () => {
		const {out} = await claimPull("Fixes #5553\n", errOut("gh: Not Found (HTTP 404)"));
		expect(out.code).toBe(OUT_OF_FOCUS);
		expect(out.stderr.some((line) => line.includes("proven absent"))).toBe(true);
	});

	it("refuses at 11 when the served issue cannot be read — UNKNOWN, never admitted", async () => {
		const {out, shell} = await claimPull("Fixes #5553\n", errOut("gh: Bad gateway (HTTP 502)"));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("judges the audience on the served issue too, so a repair lane is not refused at 21", async () => {
		const {out} = await claimPull(
			"Fixes #5553\n",
			served(44, labelled("status:triaged", "ready-for:agent")),
		);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("this issue carries ready-for:agent"))).toBe(
			true,
		);
	});

	it("leaves an issue target reading its own record — the resolution never fires on one", async () => {
		const shell = fakeShell([
			[
				ISSUE,
				issue({milestone: {number: 44}, labels: labelled("status:triaged", "ready-for:agent")}),
			],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, FOCUSED.layer)),
		);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("serves #"))).toBe(false);
	});

	it("admits an unresolvable PR while no focus is declared — an inert fence refuses nothing", async () => {
		const shell = fakeShell([
			[ISSUE, pull("No reference at all.\n")],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({...options, purpose: "gate"}),
				Layer.merge(shell.layer, NO_FOCUS.layer),
			),
		);
		expect(out.code).toBe(0);
	});

	/**
	 * The no-focus half, under the DEFAULT `build` purpose — the one that binds the audience axis, and
	 * so the one that reads whichever record the resolution returned.
	 */
	describe("with no focus declared", () => {
		const claimInert = (body: string, servedRecord: ExecResult | null) => {
			const shell = fakeShell([
				[ISSUE, pull(body)],
				...(servedRecord === null
					? []
					: ([[SERVED, servedRecord]] as ReadonlyArray<readonly [RegExp, ExecResult]>)),
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), okOut("write\n")],
			]);
			return Effect.runPromise(
				Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
			).then((out) => ({out, shell}));
		};

		it("resolves a served issue anyway, so the audience axis reads it and the claim is won", async () => {
			const {out} = await claimInert("Fixes #5553\n", served(null));
			expect(out.code).toBe(0);
			expect(out.stderr.some((line) => line.includes("PR #4312 serves #5553 (fixes)"))).toBe(true);
			expect(out.stderr.some((line) => line.includes("scope fence inert"))).toBe(true);
		});

		it("leaves an unserved PR on its own record, audience and all — the pre-#5562 answer", async () => {
			const {out, shell} = await claimInert("No reference at all.\n", null);
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
			expect(out.stderr.some((line) => line.includes("serves #"))).toBe(false);
		});

		it("still refuses at 11 when the served issue cannot be read — an inert fence does not soften UNKNOWN", async () => {
			const {out, shell} = await claimInert("Fixes #5553\n", errOut("gh: Bad gateway (HTTP 502)"));
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		});
	});

	/**
	 * The decision arm (founder ruling on #5866, built as #5914). An ADR PR is served by a
	 * `type:decision` issue, and triage routes those to `ready-for:human` — so before this the repair
	 * lane failed a fence the issue could never pass, and the only way through was an operator's
	 * `--override`, which spent the override's audit value on routine repair.
	 */
	describe("a decision issue served by an open PR", () => {
		const DECISION = labelled("status:triaged", "type:decision", "ready-for:human");

		it("admits the repair claim with no override, and writes the marker", async () => {
			const {out, shell} = await claimPull("Fixes #5553\n", served(44, DECISION));
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toEqual({
				answer: "won",
				number: 4312,
				purpose: "build",
				token: `build:s-9f2e:${LANE_UUID}`,
			});
			expect(shell.calls.some((line) => POST.test(line))).toBe(true);
			expect(
				out.stderr.some((line) =>
					line.includes(
						"repairing open PR #4312, whose served issue is type:decision: the audience axis does not bind (#5914)",
					),
				),
			).toBe(true);
		});

		it("records no override on the answer — the ruling made this the ordinary path", async () => {
			const {out} = await claimPull("Fixes #5553\n", served(44, DECISION));
			expect(JSON.parse(out.stdout).override).toBeUndefined();
		});

		it("refuses the very same issue at 21 when it is claimed directly, writing nothing", async () => {
			const shell = fakeShell([
				[ISSUE, issue({milestone: {number: 44}, labels: DECISION})],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), okOut("write\n")],
			]);
			const out = await Effect.runPromise(
				Effect.provide(runClaim(options), Layer.merge(shell.layer, FOCUSED.layer)),
			);
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
			expect(out.stderr.some((line) => line.includes("audience not agent"))).toBe(true);
		});

		it("keeps the fence for every other type an open PR serves", async () => {
			const {out, shell} = await claimPull(
				"Fixes #5553\n",
				served(44, labelled("status:triaged", "type:bug", "ready-for:human")),
			);
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		});

		it("keeps the scope fence armed — an out-of-focus decision PR is still 20", async () => {
			const {out, shell} = await claimPull("Fixes #5553\n", served(39, DECISION));
			expect(out.code).toBe(OUT_OF_FOCUS);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		});
	});
});

/**
 * The purpose axis (#5175): the audience fence binds a build claim only.
 *
 * The epic below is the census shape the ruling rests on — homed in the campaign, `type:epic`, and
 * carrying no `ready-for:` label at all, because an epic earns one only after it is planned and
 * gated. Every case runs that one issue and varies nothing but the purpose.
 */
describe("runClaim — the purpose axis", () => {
	const FOCUSED = fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}});

	const claimWith = (target: ExecResult, overrides: Partial<typeof options> = {}) => {
		const shell = fakeShell([
			[ISSUE, target],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), okOut("write\n")],
		]);
		return Effect.runPromise(
			Effect.provide(runClaim({...options, ...overrides}), Layer.merge(shell.layer, FOCUSED.layer)),
		).then((out) => ({out, shell}));
	};

	const UNLABELLED_EPIC = issue({
		milestone: {number: 44},
		labels: labelled("type:epic", "p1", "status:triaged"),
	});
	const OUT_OF_CAMPAIGN_EPIC = issue({
		milestone: {number: 39},
		labels: labelled("type:epic", "p1", "status:triaged"),
	});

	it("keeps the fence with no purpose passed — 21, and no marker written", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC);
		expect(out.code).toBe(AUDIENCE_NOT_AGENT);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("audience not agent"))).toBe(true);
	});

	it("keeps the fence under an explicit --purpose build — the default is not the only path", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC, {purpose: "build"});
		expect(out.code).toBe(AUDIENCE_NOT_AGENT);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
	});

	for (const purpose of ["plan", "gate"] as const) {
		it(`admits the same epic under --purpose ${purpose} — past the audience axis, no override`, async () => {
			const {out} = await claimWith(UNLABELLED_EPIC, {purpose});
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toEqual({
				answer: "won",
				number: 4312,
				purpose,
				token: `build:s-9f2e:${LANE_UUID}`,
			});
			expect(out.stderr.some((line) => line.includes("the audience axis does not bind"))).toBe(
				true,
			);
		});
	}

	for (const purpose of ["plan", "gate", "build"] as const) {
		it(`still refuses an out-of-focus epic on 20 under --purpose ${purpose} — scope is untouched`, async () => {
			const {out, shell} = await claimWith(OUT_OF_CAMPAIGN_EPIC, {purpose});
			expect(out.code).toBe(OUT_OF_FOCUS);
			expect(shell.calls.some((line) => POST.test(line))).toBe(false);
		});
	}

	it("refuses an off-enum purpose on 10 — never a silent fallback to build", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC, {purpose: "planning"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.some((line) => line.includes("plan | gate | build"))).toBe(true);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);
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

/**
 * The protocol's fixed point: one session, one marker, one token (#5782).
 *
 * Before the fix N claims left N markers, `claim` printed its own fresh nonce while `confirm` and
 * `requireClaim` read the earliest one, and each `release` peeled a single marker off the stack — so
 * `build branch --resume` cut its branch off a nonce the caller had never been shown.
 */
describe("the claim protocol", () => {
	const held = () => [
		[ISSUE, CLAIMABLE] as const,
		...thread(comments(), comments({id: 9001, body: MINE})),
		[POST, POSTED] as const,
		[GET_COMMENT, ECHO] as const,
		[perm("agent"), okOut("write\n")] as const,
	];

	const on = (shell: ReturnType<typeof fakeShell>, verb: typeof runClaim) =>
		Effect.runPromise(Effect.provide(verb(options), Layer.merge(shell.layer, NO_FOCUS.layer)));

	it("posts no second marker on a number this session already holds", async () => {
		const shell = fakeShell(held());
		const first = await on(shell, runClaim);
		const second = await on(shell, runClaim);
		expect(shell.calls.filter((line) => POST.test(line))).toHaveLength(1);
		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
		expect(second.stderr.at(-1)).toContain("nothing was written");
	});

	it("answers claim and confirm with the SAME token — the two can never disagree", async () => {
		const shell = fakeShell(held());
		const claimed = await on(shell, runClaim);
		const confirmed = await on(shell, runConfirm);
		expect(confirmed.code).toBe(0);
		expect(JSON.parse(confirmed.stdout).token).toBe(JSON.parse(claimed.stdout).token);
		expect(JSON.parse(claimed.stdout).token).toBe(`build:s-9f2e:${LANE_UUID}`);
	});

	it("reads a thread that already carries duplicate markers, and release clears every one", async () => {
		const dirty = comments(
			{id: 9001, body: MINE},
			{id: 9002, body: SECOND_MINE, createdAt: "2026-08-09T00:00:01Z"},
		);
		const shell = fakeShell([
			[ISSUE, CLAIMABLE],
			...thread(dirty, dirty, dirty, comments()),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[perm("agent"), okOut("write\n")],
			[DELETE, okOut("")],
		]);
		const claimed = await on(shell, runClaim);
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout).token).toBe(`build:s-9f2e:${LANE_UUID}`);
		expect(shell.calls.some((line) => POST.test(line))).toBe(false);

		const released = await on(shell, runRelease);
		expect(released.code).toBe(0);
		expect(shell.calls.filter((line) => DELETE.test(line)).sort()).toEqual([
			"gh api --method DELETE repos/o/r/issues/comments/9001",
			"gh api --method DELETE repos/o/r/issues/comments/9002",
		]);

		const confirmed = await on(shell, runConfirm);
		expect(confirmed.code).toBe(CLAIM_NOT_MINE);
		expect(confirmed.stderr.at(-1)).toContain("no claim exists on #4312");
	});
});
