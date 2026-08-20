import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {ROADMAP_FILE} from "../triage/roadmap.ts";
import {FAILED} from "../verb.ts";
import {runAdopt, runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {
	AUDIENCE_NOT_AGENT,
	BAD_SECTIONS,
	BLOCKED,
	CLAIM_NOT_MINE,
	NO_ACCEPTANCE_CRITERIA,
	OFF_VOCABULARY,
	OUT_OF_SCOPE,
	PRECONDITION_UNKNOWN,
	PRIOR_BUILD_MISMATCH,
	READBACK_MISMATCH,
	TYPE_NOT_BUILDABLE,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	adoptMarker,
	blockedBy,
	CRITERIA_BODY,
	campaignsTable,
	candidatePage,
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NO_BLOCKERS,
	NOT_FOUND,
	SIBLING_TOKEN,
	SIBLING_UUID,
	served,
	truncatedComments,
} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";

const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const POST = /^POST \S+\/repos\/o\/r\/issues\/4312\/comments/;
const GET_COMMENT = /^GET \S+\/repos\/o\/r\/issues\/comments\/9001$/;
const DELETE = /^DELETE \S+\/repos\/o\/r\/issues\/comments\//;
const perm = (login: string) => new RegExp(`^GET \\S+/repos/o/r/collaborators/${login}/permission`);

/** The two permissions the ACL answers with: one authorizes a marker, the other does not. */
const WRITES = served({permission: "write"});
const READS = served({permission: "read"});
/** What GitHub answers a successful delete with — a status and no body at all. */
const NO_CONTENT: HttpReply = {status: 204, body: ""};
const TIMEOUT: HttpReply = {status: 504, body: '{"message":"Gateway timeout"}'};

const MINE = marker("s-9f2e", LANE_UUID);
const THEIRS = marker("s-77aa", "9d8c7b6a-5f4e-3d2c-1b0a-998877665544");
/** A marker of the same SESSION under another nonce — a sibling lane's, which release must NOT sweep. */
const SIBLING_MARKER = marker("s-9f2e", SIBLING_UUID);

const POSTED = served({id: 9001, html_url: "https://github.com/o/r/issues/4312#c"}, 201);
const ECHO = served({body: MINE});

const labelled = (...names: ReadonlyArray<string>) => names.map((name) => ({name}));

/** The claim path's default target: triaged, agent-ready, unhomed — admitted under an inert fence. */
const CLAIMABLE = issue({labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent")});

/**
 * The read `claim` makes BEFORE it posts, when it was handed the token this lane already holds: this
 * thread carries no marker of this LANE yet, so the run goes on to race.
 *
 * A fresh `once` per call, because the same run then re-reads the thread at the checkpoint and must
 * see the post-state — one script entry cannot answer both reads. A claim that passes no `--token`
 * makes no such read at all, and its script carries no entry for one.
 */
const unclaimed = () => [once(COMMENTS), comments()] as const;

/**
 * The thread as it reads at each successive comment list, in call order — the last state answers
 * every read after it. The protocol reads the thread several times in one run, and a static entry
 * cannot tell a pre-post read from the checkpoint that follows it.
 */
const thread = (...states: ReadonlyArray<HttpReply>) =>
	states.map((state, i) =>
		i === states.length - 1 ? ([COMMENTS, state] as const) : ([once(COMMENTS), state] as const),
	);

/** No `ROADMAP.md`: nothing active, so the scope axis admits and the fence reports itself inert. */
const NO_CAMPAIGNS = fakeFs({files: {}});

/**
 * Both seams with every `blocked_by` edge list answering empty.
 *
 * The claim seam reads the graph on the path to every marker (ADR 0301), so a script about any other
 * axis would otherwise hit an unscripted read and refuse on `11`. A test about blockedness scripts
 * those edges itself and wins on first match.
 */
const unblocked = (script: ReadonlyArray<Scripted>) => fakeSeams([...script, NO_BLOCKERS]);

const options = {
	number: 4312,
	repo: null,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	uuid: LANE_UUID,
	token: LANE_TOKEN,
	at: "2026-08-09T00:00:00Z",
	purpose: "build",
	override: null as string | null,
	overrideLane: null as string | null,
	cites: null as string | null,
	resume: false,
};

const run = (
	verb: (given: typeof options) => ReturnType<typeof runClaim>,
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fs = NO_CAMPAIGNS,
) =>
	Effect.runPromise(
		Effect.provide(
			verb({...options, ...overrides}),
			Layer.merge(unblocked(script).layer, fs.layer),
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
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			number: 4312,
			purpose: "build",
			token: `build:s-9f2e:${LANE_UUID}`,
		});
	});

	/**
	 * The two-lanes-one-session race (#6037). Lane B mints `SIBLING_UUID`, posts it, and re-reads a
	 * thread where lane A's marker is earlier. Under the session-only rule it was told `won` and handed
	 * back a nonce that held nothing, which `build branch` then cut a branch on.
	 *
	 * It holds no token yet, so it names none, and the run makes no pre-post read at all.
	 */
	it("loses to a SIBLING LANE of its own session, and never answers won on its behalf", async () => {
		// The loser's own comment id is 9002, distinct from the winner's 9001, so the retraction
		// assertion below discriminates "retracted its own marker" from "deleted the winner's".
		const siblingMarker = marker("s-9f2e", SIBLING_UUID);
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[POST, served({id: 9002, html_url: "https://github.com/o/r/issues/4312#c"}, 201)],
			[/^GET \S+\/repos\/o\/r\/issues\/comments\/9002$/, served({body: siblingMarker})],
			[COMMENTS, comments({id: 9001, body: MINE}, {id: 9002, body: siblingMarker})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({...options, uuid: SIBLING_UUID, token: null}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.some((line) => line.includes(`lost to ${LANE_TOKEN}`))).toBe(true);
		expect(shell.requests.filter((line) => DELETE.test(line))).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/9002",
		]);
		expect(
			shell.requests.some((line) => /DELETE \S+\/repos\/o\/r\/issues\/comments\/9001/.test(line)),
		).toBe(false);
	});

	it("re-reads AFTER posting — the checkpoint is what resolves a staggered race", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		const posted = shell.requests.findIndex((line) => POST.test(line));
		const swept = shell.requests.findLastIndex((line) => COMMENTS.test(line));
		expect(posted).toBeGreaterThanOrEqual(0);
		expect(swept).toBeGreaterThan(posted);
	});

	it("exits 15 on a lost race — NEVER 0 — names the winner and retracts its own marker", async () => {
		const shell = unblocked([
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
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("lost to build:s-77aa:");
		expect(out.stderr.some((line) => line.includes("retracted this run's own marker"))).toBe(true);
		expect(
			shell.requests.some((line) => /DELETE \S+\/repos\/o\/r\/issues\/comments\/9001/.test(line)),
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
			[perm("drive-by"), READS],
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("who holds no write permission"))).toBe(true);
	});

	it("refuses a failed marker write on 8 — UNKNOWN, and hands back a RUNNABLE recovery (#6037)", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			unclaimed(),
			[POST, TIMEOUT],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		// `confirm` and `release` both require --token, so the minted token has to reach the operator
		// or the lane can address neither the marker this write may have landed nor its own claim.
		expect(out.stderr.at(-1)).toContain(
			`run "fabrika build confirm 4312 --token ${LANE_TOKEN}" before any further action`,
		);
		expect(out.stderr.join("\n")).toContain(`the token this run minted is ${LANE_TOKEN}`);
		expect(out.stderr.join("\n")).toContain('Do not re-run "fabrika build claim 4312"');
	});

	it("refuses a marker that does not read back on 9", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, served({body: "something else"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses an unreadable marker set on 11 — never 'unclaimed'", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('ownership is UNKNOWN, never "unclaimed"');
	});

	it("refuses a TRUNCATED marker read on 11 and keeps its own marker — a short read is not a loss", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("GitHub answered 200 but its body is not a list");
		expect(out.stderr.some((line) => line.includes("is not authorized"))).toBe(false);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses an unreadable PERMISSION on 11 — a transient read never demotes an author", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a missing session id on 1, NOT on 15 — the two were fused in v1", async () => {
		const out = await run(runClaim, [], {env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV}});
		expect(out.code).toBe(FAILED);
	});

	it("refuses a proven-absent issue on 7", async () => {
		const out = await run(runClaim, [[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

/**
 * The fence, at the seam where it has teeth.
 *
 * Every refusal below asserts on **`shell.requests`** as well as the exit code: "refuses" and "refuses
 * before writing anything" are different claims, and only the call log can tell them apart. A claim
 * that posted and then refused would leave a marker on the issue with nothing to retract it.
 */
describe("runClaim — the admission test runs before any marker is written", () => {
	const IN_SCOPE = fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}});

	const claimWith = (target: HttpReply, fs = IN_SCOPE, overrides: Partial<typeof options> = {}) => {
		const shell = unblocked([
			[ISSUE, target],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
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

	it("refuses an out-of-scope issue on 20, and posts NOTHING", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN);
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(out.stdout).toBe("");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("out of scope"))).toBe(true);
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("claims an issue homed in the SECOND declared milestone, off the same predicate (#6005)", async () => {
		const {out} = await claimWith(
			OUT_OF_CAMPAIGN,
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable([44, 39])}}),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
		expect(out.stderr.some((line) => line.includes("2 active"))).toBe(true);
	});

	it("refuses an out-of-scope issue naming the whole active set in the remedy", async () => {
		const {out} = await claimWith(
			OUT_OF_CAMPAIGN,
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable([44, 46])}}),
		);
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(out.stderr.some((line) => line.includes("milestones #44, #46"))).toBe(true);
	});

	it("refuses a non-agent audience on 21 — a sibling axis, never folded into 20", async () => {
		const {out, shell} = await claimWith(HUMAN_AUDIENCE);
		expect(out.code).toBe(AUDIENCE_NOT_AGENT);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("ready-for:human"))).toBe(true);
	});

	/**
	 * The dispatch route's own regression. `build pick` has always excluded a body with no readable
	 * contract, but the pool is the browse path: a number handed straight to `claim` — an operator
	 * naming a lane, an `operate` lane, a resume — passed through no pool, so the same issue reached
	 * construction and `review criteria` was the first thing to catch it, a whole build later
	 * (#6554, on #6462 → PR #6552).
	 */
	const NO_CONTRACT = issue({
		milestone: {number: 44},
		labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent"),
		body: "## What this is\n\nprose and pointers, and no contract anywhere.\n",
	});
	const DRIFTED_HEADING = issue({
		milestone: {number: 44},
		labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent"),
		body: "## What this is\n\n### Acceptance Criteria:\n\n- [ ] the heading drifted\n",
	});

	it("refuses a body with no acceptance-criteria block on 32, and posts NOTHING", async () => {
		const {out, shell} = await claimWith(NO_CONTRACT);
		expect(out.code).toBe(NO_ACCEPTANCE_CRITERIA);
		expect(out.stdout).toBe("");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.join("\n")).toContain("no acceptance criteria");
		expect(out.stderr.join("\n")).toContain("triage enrich");
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("keeps that refusal off the override path — the repair belongs on the issue", async () => {
		const {out, shell} = await claimWith(NO_CONTRACT, IN_SCOPE, {
			override: "I would like to build it anyway",
			overrideLane: "build",
		});
		expect(out.code).toBe(NO_ACCEPTANCE_CRITERIA);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.at(-1)).not.toContain("--override");
	});

	it("refuses a drifted heading on the same code and names the mechanical repair instead", async () => {
		const {out} = await claimWith(DRIFTED_HEADING);
		expect(out.code).toBe(NO_ACCEPTANCE_CRITERIA);
		expect(out.stderr.join("\n")).toContain("triage repair-criteria");
	});

	it("does not fence a plan claim on it — an epic's criteria arrive per child (#6025)", async () => {
		const {out} = await claimWith(NO_CONTRACT, IN_SCOPE, {purpose: "plan"});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
	});

	it("refuses an unreadable declaration on 11 — scope is UNKNOWN, never admitted", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[ROADMAP_FILE]: null}, unprobeable: [ROADMAP_FILE]}),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.at(-1)).toContain("scope is UNKNOWN, never admitted; nothing was written");
	});

	it("refuses a malformed campaigns table on 4 — never read as 'nothing active'", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44).replace("| active |", "| activ |")}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("claims a refused issue under --override, recording the lane and reason on the marker and in the answer", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, IN_SCOPE, {
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
		const posted = shell.bodies.filter(
			(_, index) => POST.test(shell.requests[index] ?? "") === true,
		);
		expect(
			posted.some((body) =>
				body.includes("build-claim-override: build-ui · hotfix for the release blocker"),
			),
		).toBe(true);
	});

	it("never lets --override past an UNKNOWN admission — a failed read has proven nothing", async () => {
		const {out, shell} = await claimWith(
			CLAIMABLE,
			fakeFs({files: {[ROADMAP_FILE]: null}, unprobeable: [ROADMAP_FILE]}),
			{override: "I know what I am doing", overrideLane: "build-ui"},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an empty --override reason on 1 — an override is recorded or it is not one", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, IN_SCOPE, {
			override: "  ",
			overrideLane: "build-ui",
		});
		expect(out.code).toBe(FAILED);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an --override that names no lane on 1 — the escape hatch says who took it (#5175)", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, IN_SCOPE, {
			override: "hotfix for the release blocker",
		});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.some((line) => line.includes("--override-lane"))).toBe(true);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses a blank --override-lane on 1 — whitespace names no lane", async () => {
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN, IN_SCOPE, {
			override: "hotfix for the release blocker",
			overrideLane: "   ",
		});
		expect(out.code).toBe(FAILED);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an --override-lane with no --override on 1 — a lane names no override alone", async () => {
		const {out, shell} = await claimWith(CLAIMABLE, IN_SCOPE, {overrideLane: "build-ui"});
		expect(out.code).toBe(FAILED);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("names the declaration it judged against on a win, so an inert-fence claim reads as one", async () => {
		const {out} = await claimWith(
			issue({milestone: {number: 44}, labels: labelled("status:triaged", "ready-for:agent")}),
		);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("build claim: campaigns: 1 active — Campaign 44 (#44).");
	});

	it("refuses by NUMBER the very issue the pool excluded — the direct handoff is fenced too", async () => {
		const row = {
			number: 4312,
			labels: ["status:triaged", "ready-for:agent", "type:bug"],
			milestone: 39,
		};
		const picked = await Effect.runPromise(
			Effect.provide(
				runPick({repo: null, limit: 20, cwd: "/repo", env: options.env}),
				Layer.merge(
					unblocked([
						[/labels=status%3Atriaged%2Cp0/, candidatePage(row)],
						[/labels=status%3Atriaged%2Cp[12]/, served([])],
					]).layer,
					IN_SCOPE.layer,
				),
			),
		);
		expect(JSON.parse(picked.stdout).pool).toEqual([]);
		expect(JSON.parse(picked.stdout).excluded).toEqual({"out-of-scope": 1});

		// The same issue, handed straight to `claim` by number: the pool was bypassed, the fence is not.
		const {out, shell} = await claimWith(OUT_OF_CAMPAIGN);
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("leaves confirm and release outside the fence — a mid-lane pause strands no lane", async () => {
		const script: ReadonlyArray<Scripted> = [
			[ISSUE, OUT_OF_CAMPAIGN],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		];
		const confirmed = await run(runConfirm, script, {}, IN_SCOPE);
		expect(confirmed.code).toBe(0);
		const released = await run(runRelease, script, {}, IN_SCOPE);
		expect(released.code).toBe(0);
	});
});

/**
 * Repair claims a PR number, and a PR carries no milestone and no `ready-for:` label of its own — so
 * while any campaign was active the fence refused every one of them (#5562). The subject the two axes
 * read is the issue the PR's lane serves.
 */
describe("runClaim — a PR number is judged by the issue it serves", () => {
	const IN_SCOPE = fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}});
	const SERVED = /^GET \S+\/repos\/o\/r\/issues\/5553$/;

	const pull = (body: string) =>
		issue({
			title: "fix(build): the repair lane",
			body,
			labels: [],
			milestone: null,
			pull_request: {url: "https://api.github.com/repos/o/r/pulls/4312"},
		});

	const servedTicket = (
		milestone: number | null,
		labels = labelled("status:triaged", "ready-for:agent"),
	) =>
		served({
			number: 5553,
			title: "The ticket the lane serves",
			body: CRITERIA_BODY,
			state: "open",
			labels,
			html_url: "https://github.com/o/r/issues/5553",
			milestone: milestone === null ? null : {number: milestone},
			state_reason: null,
		});

	const claimPull = (
		body: string,
		servedRecord: HttpReply,
		overrides: Partial<typeof options> = {},
	) => {
		const shell = unblocked([
			[ISSUE, pull(body)],
			[SERVED, servedRecord],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		return Effect.runPromise(
			Effect.provide(
				runClaim({...options, ...overrides}),
				Layer.merge(shell.layer, IN_SCOPE.layer),
			),
		).then((out) => ({out, shell}));
	};

	it("admits a PR whose served issue is in scope, with no override", async () => {
		const {out} = await claimPull("Fixes #5553\n", servedTicket(44));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
		expect(out.stderr.some((line) => line.includes("PR #4312 serves #5553 (fixes)"))).toBe(true);
	});

	it("reads Part of #<n> too — the partial-PR shape build --partial emits", async () => {
		const {out} = await claimPull("Part of #5553\n", servedTicket(44));
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("serves #5553 (part-of)"))).toBe(true);
	});

	it("still refuses at 20 when the served issue is genuinely out of scope, and posts NOTHING", async () => {
		const {out, shell} = await claimPull("Fixes #5553\n", servedTicket(39));
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("out of scope"))).toBe(true);
		expect(out.stderr.some((line) => line.includes("this issue's home is 39"))).toBe(true);
	});

	it("keeps that refusal overridable", async () => {
		const {out} = await claimPull("Fixes #5553\n", servedTicket(39), {
			override: "repairing a landed FAIL",
			overrideLane: "build",
		});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
	});

	it("refuses a PR naming no issue at 20, saying which case fired — and stays overridable", async () => {
		const body = "A conversation-authored ADR.\n\n## Deviations\nNone.\n";
		const {out, shell} = await claimPull(body, servedTicket(44));
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("no served issue"))).toBe(true);
		const overridden = await claimPull(body, servedTicket(44), {
			override: "no ticket — the ADR was authored in conversation",
			overrideLane: "build",
		});
		expect(overridden.out.code).toBe(0);
	});

	it("refuses at 20 when the named issue is proven absent — never on the PR's own empty home", async () => {
		const {out} = await claimPull("Fixes #5553\n", NOT_FOUND);
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(out.stderr.some((line) => line.includes("proven absent"))).toBe(true);
	});

	it("refuses at 11 when the served issue cannot be read — UNKNOWN, never admitted", async () => {
		const {out, shell} = await claimPull("Fixes #5553\n", GATEWAY);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	/**
	 * The prior-build gate asks "has this child been built and graded", which a repair lane has
	 * already answered by naming a PR — `build verdicts` folds that PR's own verdicts. So the gate
	 * must not fire here: it would cost a comment page for nothing, and a PR thread carrying a range
	 * marker or a broken one would refuse the very repair it was written to route to (#6386).
	 */
	it("never runs the prior-build gate on a PR target — repair has already answered its question", async () => {
		const {out, shell} = await claimPull("Fixes #5553\n", servedTicket(44));
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).not.toContain("standing range verdict");
		// Two comment reads on the admitting path: the existing-claim scan, and the marker read-back.
		expect(shell.requests.filter((line) => COMMENTS.test(line))).toHaveLength(2);
	});

	it("judges the audience on the served issue too, so a repair lane is not refused at 21", async () => {
		const {out} = await claimPull(
			"Fixes #5553\n",
			servedTicket(44, labelled("status:triaged", "ready-for:agent")),
		);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("this issue carries ready-for:agent"))).toBe(
			true,
		);
	});

	it("leaves an issue target reading its own record — the resolution never fires on one", async () => {
		const shell = unblocked([
			[
				ISSUE,
				issue({milestone: {number: 44}, labels: labelled("status:triaged", "ready-for:agent")}),
			],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, IN_SCOPE.layer)),
		);
		expect(out.code).toBe(0);
		expect(out.stderr.some((line) => line.includes("serves #"))).toBe(false);
	});

	it("admits an unresolvable PR while no campaign is active — an inert fence refuses nothing", async () => {
		const shell = unblocked([
			[ISSUE, pull("No reference at all.\n")],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({...options, purpose: "gate"}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(0);
	});

	/**
	 * The nothing-active half, under the DEFAULT `build` purpose — the one that binds the audience axis, and
	 * so the one that reads whichever record the resolution returned.
	 */
	describe("with no campaign active", () => {
		const claimInert = (body: string, servedRecord: HttpReply | null) => {
			const shell = unblocked([
				[ISSUE, pull(body)],
				...(servedRecord === null ? [] : ([[SERVED, servedRecord]] as ReadonlyArray<Scripted>)),
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			]);
			return Effect.runPromise(
				Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
			).then((out) => ({out, shell}));
		};

		it("resolves a served issue anyway, so the audience axis reads it and the claim is won", async () => {
			const {out} = await claimInert("Fixes #5553\n", servedTicket(null));
			expect(out.code).toBe(0);
			expect(out.stderr.some((line) => line.includes("PR #4312 serves #5553 (fixes)"))).toBe(true);
			expect(out.stderr.some((line) => line.includes("scope fence inert"))).toBe(true);
		});

		it("leaves an unserved PR on its own record, audience and all — the pre-#5562 answer", async () => {
			const {out, shell} = await claimInert("No reference at all.\n", null);
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
			expect(out.stderr.some((line) => line.includes("serves #"))).toBe(false);
		});

		it("still refuses at 11 when the served issue cannot be read — an inert fence does not soften UNKNOWN", async () => {
			const {out, shell} = await claimInert("Fixes #5553\n", GATEWAY);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
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
			const {out, shell} = await claimPull("Fixes #5553\n", servedTicket(44, DECISION));
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toEqual({
				answer: "won",
				number: 4312,
				purpose: "build",
				token: `build:s-9f2e:${LANE_UUID}`,
			});
			expect(shell.requests.some((line) => POST.test(line))).toBe(true);
			expect(
				out.stderr.some((line) =>
					line.includes(
						"repairing open PR #4312, whose served issue is type:decision: the audience axis does not bind (#5914)",
					),
				),
			).toBe(true);
		});

		it("records no override on the answer — the ruling made this the ordinary path", async () => {
			const {out} = await claimPull("Fixes #5553\n", servedTicket(44, DECISION));
			expect(JSON.parse(out.stdout).override).toBeUndefined();
		});

		// It refused at 21 until #5490 seated the type axis. The exemption's other arm is unchanged —
		// the direct claim is still refused, still writes nothing — but the reason it prints is now the
		// objection an operator can act on rather than a label they could talk past.
		it("refuses the very same issue on type when it is claimed directly, writing nothing", async () => {
			const shell = unblocked([
				[ISSUE, issue({milestone: {number: 44}, labels: DECISION})],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			]);
			const out = await Effect.runPromise(
				Effect.provide(runClaim(options), Layer.merge(shell.layer, IN_SCOPE.layer)),
			);
			expect(out.code).toBe(TYPE_NOT_BUILDABLE);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
			expect(out.stderr.some((line) => line.includes("type not buildable"))).toBe(true);
		});

		it("leaves the audience fence standing — a cited ruling opens type, and only type", async () => {
			const shell = unblocked([
				[ISSUE, issue({milestone: {number: 44}, labels: DECISION})],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			]);
			const out = await Effect.runPromise(
				Effect.provide(
					runClaim({
						...options,
						cites: "https://github.com/o/r/issues/4312#issuecomment-5335398768",
					}),
					Layer.merge(shell.layer, IN_SCOPE.layer),
				),
			);
			// The DECISION fixture is `ready-for:human`, which triage re-stamps when it routes a ruled
			// decision to an agent. Until it does, the claim stops here (ADR 0300's binding constraint).
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		});

		it("takes the ruled decision once triage has stamped it for an agent", async () => {
			const shell = unblocked([
				[
					ISSUE,
					issue({
						milestone: {number: 44},
						labels: labelled("status:triaged", "type:decision", "ready-for:agent"),
					}),
				],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			]);
			const cites = "https://github.com/o/r/issues/4312#issuecomment-5335398768";
			const out = await Effect.runPromise(
				Effect.provide(runClaim({...options, cites}), Layer.merge(shell.layer, IN_SCOPE.layer)),
			);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout).cites).toBe(cites);
			expect(out.stderr.some((line) => line.includes(cites))).toBe(true);
		});

		it("refuses a citation recorded on some other issue, before any marker", async () => {
			const shell = unblocked([
				[ISSUE, issue({milestone: {number: 44}, labels: DECISION})],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			]);
			const out = await Effect.runPromise(
				Effect.provide(
					runClaim({
						...options,
						cites: "https://github.com/o/r/issues/9999#issuecomment-5335398768",
					}),
					Layer.merge(shell.layer, IN_SCOPE.layer),
				),
			);
			expect(out.code).toBe(1);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		});

		it("keeps the fence for every other type an open PR serves", async () => {
			const {out, shell} = await claimPull(
				"Fixes #5553\n",
				servedTicket(44, labelled("status:triaged", "type:bug", "ready-for:human")),
			);
			expect(out.code).toBe(AUDIENCE_NOT_AGENT);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		});

		it("keeps the scope fence armed — an out-of-scope decision PR is still 20", async () => {
			const {out, shell} = await claimPull("Fixes #5553\n", servedTicket(39, DECISION));
			expect(out.code).toBe(OUT_OF_SCOPE);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
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
	const IN_SCOPE = fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}});

	const claimWith = (target: HttpReply, overrides: Partial<typeof options> = {}) => {
		const shell = unblocked([
			[ISSUE, target],
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		return Effect.runPromise(
			Effect.provide(
				runClaim({...options, ...overrides}),
				Layer.merge(shell.layer, IN_SCOPE.layer),
			),
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

	// Both fences bind this epic under build. It refused at 21 until #5490 seated the type axis; type
	// is read first now, and an epic is refused whatever its `ready-for:` label says, which is what
	// the audience axis alone could never prove. The `type:bug` case below keeps 21 under test.
	it("keeps the fence with no purpose passed — 30, and no marker written", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC);
		expect(out.code).toBe(TYPE_NOT_BUILDABLE);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.some((line) => line.includes("type not buildable"))).toBe(true);
	});

	it("keeps the fence under an explicit --purpose build — the default is not the only path", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC, {purpose: "build"});
		expect(out.code).toBe(TYPE_NOT_BUILDABLE);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("still seats 21 under build on a type the type axis admits", async () => {
		const {out, shell} = await claimWith(
			issue({milestone: {number: 44}, labels: labelled("type:bug", "p1", "status:triaged")}),
		);
		expect(out.code).toBe(AUDIENCE_NOT_AGENT);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
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
		it(`still refuses an out-of-scope epic on 20 under --purpose ${purpose} — scope is untouched`, async () => {
			const {out, shell} = await claimWith(OUT_OF_CAMPAIGN_EPIC, {purpose});
			expect(out.code).toBe(OUT_OF_SCOPE);
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		});
	}

	it("refuses an off-enum purpose on 10 — never a silent fallback to build", async () => {
		const {out, shell} = await claimWith(UNLABELLED_EPIC, {purpose: "planning"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.some((line) => line.includes("plan | gate | build"))).toBe(true);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});
});

describe("runConfirm", () => {
	it("answers mine when this lane holds the earliest authorized marker", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "mine", number: 4312, token: LANE_TOKEN});
	});

	it("refuses a SIBLING LANE OF THIS SESSION on 15, naming both tokens (#6037)", async () => {
		const out = await run(
			runConfirm,
			[
				[ISSUE, CLAIMABLE],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			],
			{token: SIBLING_TOKEN},
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			`build confirm: #4312 is held by ${LANE_TOKEN}, not by ${SIBLING_TOKEN} — another lane of this same session.`,
		);
	});

	it("refuses a foreign holder on 15, naming the token", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			"build confirm: #4312 is held by build:s-77aa:9d8c7b6a-5f4e-3d2c-1b0a-998877665544, not by " +
				LANE_TOKEN +
				".",
		);
	});

	it("refuses proven-unclaimed on 15 too, with the no-claim message", async () => {
		const out = await run(runConfirm, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, served([])],
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
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("GitHub answered 200 but its body is not a list");
	});
});

describe("runRelease", () => {
	it("retracts this session's OWN marker and nothing else", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "released", number: 4312});
		expect(shell.requests.filter((line) => DELETE.test(line))).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/9001",
		]);
	});

	it("refuses to release another lane's claim on 15, and deletes nothing", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.at(-1)).toBe(
			"build release: this lane holds no claim on #4312 — refusing to release another lane's.",
		);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses a truncated read on 11 and deletes nothing", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});

	it("refuses a failed retraction on 8 — whether the claim is still held is UNKNOWN", async () => {
		const out = await run(runRelease, [
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
			[once(DELETE), TIMEOUT],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(`run "fabrika build confirm 4312 --token ${LANE_TOKEN}"`);
	});
});

/**
 * The protocol's fixed point: one LANE, one marker, one token (#5782, scoped per lane by #6037).
 *
 * Before #5782 N claims left N markers, `claim` printed its own fresh nonce while `confirm` and
 * `requireClaim` read the earliest one, and each `release` peeled a single marker off the stack — so
 * `build branch --resume` cut its branch off a nonce the caller had never been shown. That fix held
 * the fixed point per SESSION, which is the rule that told a sibling lane it owned its neighbour's
 * claim (#6037). Each property is asserted here per lane instead, and every one of them is paired
 * with the sibling case it must NOT swallow: idempotence short-circuits only for the lane that named
 * its own token, and release retracts only markers carrying that token.
 */
describe("the claim protocol", () => {
	const held = () => [
		[ISSUE, CLAIMABLE] as const,
		...thread(comments(), comments({id: 9001, body: MINE})),
		[POST, POSTED] as const,
		[GET_COMMENT, ECHO] as const,
		[perm("agent"), WRITES] as const,
	];

	const on = (
		shell: ReturnType<typeof fakeSeams>,
		verb: (given: typeof options) => ReturnType<typeof runClaim>,
	) =>
		Effect.runPromise(Effect.provide(verb(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)));

	it("posts no second marker on a number THIS LANE already holds", async () => {
		const shell = unblocked(held());
		const first = await on(shell, runClaim);
		const second = await on(shell, runClaim);
		expect(shell.requests.filter((line) => POST.test(line))).toHaveLength(1);
		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
		expect(second.stderr.at(-1)).toContain("already held by this lane");
		expect(second.stderr.at(-1)).toContain("nothing was written");
	});

	/**
	 * The narrowing itself. Under the session-scoped short-circuit, lane B naming its own token on a
	 * number lane A holds was answered `won` with lane A's marker — the #6037 defect, arriving through
	 * #5782's idempotence rather than through the race.
	 */
	it("does NOT short-circuit for a sibling lane's marker — it races it, and loses", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			...thread(
				comments({id: 9001, body: MINE}),
				comments({id: 9001, body: MINE}, {id: 9002, body: SIBLING_MARKER}),
			),
			[POST, served({id: 9002, html_url: "https://github.com/o/r/issues/4312#c"}, 201)],
			[/^GET \S+\/repos\/o\/r\/issues\/comments\/9002$/, served({body: SIBLING_MARKER})],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({...options, uuid: SIBLING_UUID, token: SIBLING_TOKEN}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.some((line) => line.includes(`lost to ${LANE_TOKEN}`))).toBe(true);
		expect(shell.requests.filter((line) => DELETE.test(line))).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/9002",
		]);
	});

	it("answers claim and confirm with the SAME token — the two can never disagree", async () => {
		const shell = unblocked(held());
		const claimed = await on(shell, runClaim);
		const confirmed = await on(shell, runConfirm);
		expect(confirmed.code).toBe(0);
		expect(JSON.parse(confirmed.stdout).token).toBe(JSON.parse(claimed.stdout).token);
		expect(JSON.parse(claimed.stdout).token).toBe(LANE_TOKEN);
	});

	it("clears every duplicate of THIS LANE's token on release, and leaves a sibling's standing", async () => {
		// 9001 and 9002 both carry this lane's token — a write that reported UNKNOWN, landed, and was
		// re-posted. 9003 is a sibling lane's claim: retracting it is the one write this protocol must
		// never make, so it survives the sweep and is what `confirm` then loses to.
		const dirty = comments(
			{id: 9001, body: MINE},
			{id: 9002, body: MINE, createdAt: "2026-08-09T00:00:01Z"},
			{id: 9003, body: SIBLING_MARKER, createdAt: "2026-08-09T00:00:02Z"},
		);
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			...thread(dirty, dirty, dirty, comments({id: 9003, body: SIBLING_MARKER})),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const claimed = await on(shell, runClaim);
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout).token).toBe(LANE_TOKEN);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);

		const released = await on(shell, runRelease);
		expect(released.code).toBe(0);
		expect(shell.requests.filter((line) => DELETE.test(line)).sort()).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/9001",
			"DELETE https://api.github.com/repos/o/r/issues/comments/9002",
		]);

		const confirmed = await on(shell, runConfirm);
		expect(confirmed.code).toBe(CLAIM_NOT_MINE);
		expect(confirmed.stderr.at(-1)).toBe(
			`build confirm: #4312 is held by ${SIBLING_TOKEN}, not by ${LANE_TOKEN} — another lane of this same session.`,
		);
	});
});

/**
 * Board-attested succession (ADR 0295): the dead session's claim becomes this session's through an
 * adopt marker on the same number, and never through a TTL, a lease or a steal.
 */
describe("runAdopt / succession", () => {
	const DEAD = "s-77aa";
	const ADOPT = adoptMarker(DEAD, "s-9f2e", LANE_UUID);
	const adoptOptions = {
		number: 4312,
		repo: null,
		env: options.env,
		session: DEAD,
		reason: "the driver session died mid-flight",
		uuid: LANE_UUID,
		at: "2026-08-09T00:00:00Z",
	};

	const runAdoptWith = (
		script: ReadonlyArray<Scripted>,
		overrides: Partial<typeof adoptOptions> = {},
	) =>
		Effect.runPromise(
			Effect.provide(
				runAdopt({...adoptOptions, ...overrides}),
				Layer.merge(unblocked(script).layer, NO_CAMPAIGNS.layer),
			),
		);

	it("posts the adopt marker naming the dead session and this session's token", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, served({body: ADOPT})],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runAdopt(adoptOptions), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "adopted",
			number: 4312,
			session: DEAD,
			token: `build:s-9f2e:${LANE_UUID}`,
		});
		expect(shell.requests.filter((line) => POST.test(line))).toHaveLength(1);
	});

	it("refuses an adopt naming this very session, and writes nothing", async () => {
		const shell = unblocked([[ISSUE, CLAIMABLE]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runAdopt({...adoptOptions, session: "s-9f2e"}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("already covers");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an empty reason before anything is read", async () => {
		const out = await runAdoptWith([[ISSUE, CLAIMABLE]], {reason: "  "});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("--reason is empty");
	});

	it("refuses a --session carrying whitespace or the field separator, before the write", async () => {
		for (const session of ["s-77aa dead", "s-77aa·2"]) {
			const shell = unblocked([[ISSUE, CLAIMABLE]]);
			const out = await Effect.runPromise(
				Effect.provide(
					runAdopt({...adoptOptions, session}),
					Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
				),
			);
			expect(out.code).toBe(FAILED);
			expect(out.stderr.at(-1)).toContain("no reader can read back");
			expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		}
	});

	it("refuses a multi-line --reason rather than recording its first line only", async () => {
		const shell = unblocked([[ISSUE, CLAIMABLE]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runAdopt({...adoptOptions, reason: "outage\nand context loss"}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("one line");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	// A tokenless `claim` over an adopted number is the shape a real successor produces: `adopt` ran
	// under its own nonce, this run mints another, and succession turns on the WHOLE token — so the
	// adopt names a lane that is not this run and ownership resolves `Foreign`. The lose path retracts
	// this run's own marker, which is what leaves no orphan behind the release (AC 9).
	it("claim on an adopted number loses and retracts its own marker — release comes first", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{
						id: 8100,
						body: adoptMarker(DEAD, "s-9f2e", SIBLING_UUID),
						createdAt: "2026-08-10T00:00:00Z",
					},
					{id: 9001, body: MINE, createdAt: "2026-08-11T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({...options, token: null}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.some((line) => line.includes("lost to build:s-77aa:"))).toBe(true);
		expect(shell.requests.filter((line) => DELETE.test(line))).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/9001",
		]);
	});

	it("claim --token over an adopted claim refuses before writing anything", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{id: 8100, body: ADOPT, createdAt: "2026-08-10T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		// The token named is the ADOPT's — the one `release` accepts — never the dead session's winner.
		expect(out.stderr.some((line) => line.includes(`--token ${LANE_TOKEN}`))).toBe(true);
		expect(shell.requests.some((line) => POST.test(line) || DELETE.test(line))).toBe(false);
	});

	it("release still refuses the dead session's claim while no adopt marker names it", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[COMMENTS, comments({id: 8000, body: THEIRS})],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.some((line) => line.includes("fabrika build adopt 4312 --session"))).toBe(
			true,
		);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});

	it("release retracts BOTH markers once an authorized adopt names the dead session", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{id: 8100, body: ADOPT, createdAt: "2026-08-10T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
			[DELETE, NO_CONTENT],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "released", number: 4312, adopted: DEAD});
		expect(shell.requests.filter((line) => DELETE.test(line))).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/comments/8000",
			"DELETE https://api.github.com/repos/o/r/issues/comments/8100",
		]);
	});

	// `confirm` is what every number-addressed mutation runs first, and what it answers is what the
	// caller threads onward. On a succession the winning marker is the DEAD session's, whose token
	// `requireCallerToken` refuses on `1` — so the answer is the adopt's, this lane's own.
	it("confirm on an adopted claim answers the adopt's token, never the dead session's", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{id: 8100, body: ADOPT, createdAt: "2026-08-10T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runConfirm(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "mine", number: 4312, token: LANE_TOKEN});
	});

	it("ignores an adopt marker whose poster holds no write permission — content is not authority", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{id: 8100, body: ADOPT, author: "drive-by", createdAt: "2026-08-10T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
			[perm("drive-by"), READS],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runRelease(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.some((line) => line.includes("counted, never a succession"))).toBe(true);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});

	// The adopt names ONE lane by its whole token, so succession confers exactly what an ordinary win
	// confers and never re-widens ownership back to a session (#6060). A third session and a sibling
	// lane of the successor's own session are refused by the same test, which is the point.
	it.each([
		["a third session", "s-3rd", `build:s-3rd:${LANE_UUID}`],
		["a sibling lane of the successor's session", "s-9f2e", SIBLING_TOKEN],
	])("confers the claim on the named lane only — %s reads Foreign", async (_who, session, token) => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			[
				COMMENTS,
				comments(
					{id: 8000, body: THEIRS},
					{id: 8100, body: ADOPT, createdAt: "2026-08-10T00:00:00Z"},
				),
			],
			[perm("agent"), WRITES],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRelease({...options, token, env: {...options.env, CLAUDE_CODE_SESSION_ID: session}}),
				Layer.merge(shell.layer, NO_CAMPAIGNS.layer),
			),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(shell.requests.some((line) => DELETE.test(line))).toBe(false);
	});
});

/**
 * The precondition gate ADR 0301 puts on the claim seam: the native `blocked_by` graph is the one
 * carrier of "do not start this yet", and a number handed straight to a lane passes through no pool,
 * so this is where the refusal has teeth.
 */
describe("runClaim — the blockedness gate", () => {
	const EDGES = /^GET \S+\/repos\/o\/r\/issues\/4312\/dependencies\/blocked_by/;
	const blocker = (n: number) => new RegExp(`^GET \\S+/repos/o/r/issues/${n}$`);

	const claimAgainst = (graph: ReadonlyArray<Scripted>) => {
		const shell = fakeSeams([
			[ISSUE, CLAIMABLE],
			...graph,
			unclaimed(),
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		return Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		).then((out) => ({out, shell}));
	};

	it("refuses a number with an open blocked_by edge on 16, and posts NOTHING", async () => {
		const {out, shell} = await claimAgainst([
			[EDGES, blockedBy(210)],
			[blocker(210), issue({number: 210, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stdout).toBe("");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.at(-1)).toContain("blocked by 1 open blocked_by edge: #210");
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("names EVERY open blocker, so one call tells the lane the whole wait", async () => {
		const {out} = await claimAgainst([
			[EDGES, blockedBy(210, 211, 212)],
			[blocker(210), issue({number: 210, state: "open"})],
			[blocker(211), issue({number: 211, state: "closed"})],
			[blocker(212), issue({number: 212, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toContain("blocked by 2 open blocked_by edges: #210, #212");
	});

	it("admits a number whose every blocker is closed — unblocking is derived, never performed", async () => {
		const {out} = await claimAgainst([
			[EDGES, blockedBy(210)],
			[blocker(210), issue({number: 210, state: "closed"})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("won");
		expect(out.stderr.join("\n")).toContain("scanned 1 blocked_by edge; none open");
	});

	it('refuses an unreadable edge list on 11 — UNKNOWN is never "not blocked"', async () => {
		const {out, shell} = await claimAgainst([[EDGES, GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
		expect(out.stderr.at(-1)).toContain("cannot read the blocked_by edges of #4312");
	});

	it("refuses on 11 when a blocker's own state could not be read and nothing is proven open", async () => {
		const {out} = await claimAgainst([
			[EDGES, blockedBy(210)],
			[blocker(210), GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("blocker #210");
	});

	/**
	 * The ordering ADR 0301 names: the two pure axes answer without IO, so a number the fence already
	 * refuses must never cost the graph read. The proof is the absent call, not the exit code.
	 */
	it("reads no edges at all when a pure axis already refused", async () => {
		const shell = fakeSeams([
			[
				ISSUE,
				issue({
					milestone: {number: 39},
					labels: labelled("type:bug", "p1", "status:triaged", "ready-for:agent"),
				}),
			],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim(options),
				Layer.merge(shell.layer, fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}}).layer),
			),
		);
		expect(out.code).toBe(OUT_OF_SCOPE);
		expect(shell.requests.some((line) => EDGES.test(line))).toBe(false);
	});
});

/**
 * The FAIL-then-respawn path (#6386): an epic child released after a `FAIL` was offered to the next
 * lane as ordinary work, because "no lane holds this number" and "this number has no reviewed build"
 * are different facts and the protocol only ever asked the first. It reproduced twice on epic #5631,
 * each time costing a whole build lane and, on #6298, producing two divergent implementations of one
 * criterion.
 */
describe("runClaim — the prior-build gate on an epic child", () => {
	const RANGE =
		"9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4..03135b917283a4b5c6d7e8f90a1b2c3d4e5f6071";
	const rangeVerdict = (polarity: string) =>
		`review-code: ${polarity} range:${RANGE} content:2f1a9c4e0b7d — the child's range`;

	it("refuses a fresh build claim on a child whose newest range verdict is FAIL", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[COMMENTS, comments({id: 8801, body: rangeVerdict("FAIL")})],
		]);
		expect(out.code).toBe(PRIOR_BUILD_MISMATCH);
		expect(out.stderr.join("\n")).toContain("review-code FAIL over");
		expect(out.stderr.join("\n")).toContain("comment 8801");
		expect(out.stderr.join("\n")).toContain('"fabrika build claim 4312 --resume"');
		expect(out.stderr.join("\n")).toContain("--resume-lane");
	});

	it("writes no marker when it refuses — the claim path leaves nothing to retract", async () => {
		const shell = unblocked([
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[COMMENTS, comments({id: 8801, body: rangeVerdict("FAIL")})],
		]);
		await Effect.runPromise(
			Effect.provide(runClaim(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(shell.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("admits the claim under --resume, so the refusal points at a route that exists", async () => {
		const out = await run(
			runClaim,
			[
				[ISSUE, CLAIMABLE],
				unclaimed(),
				[once(COMMENTS), comments({id: 8801, body: rangeVerdict("FAIL")})],
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			],
			{resume: true},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "won", purpose: "build"});
		expect(out.stderr.join("\n")).toContain("--resume-lane");
	});

	it("refuses --resume on a child holding no standing FAIL — the flag is checked, not trusted", async () => {
		const out = await run(
			runClaim,
			[
				[ISSUE, CLAIMABLE],
				unclaimed(),
				[COMMENTS, comments({id: 8801, body: rangeVerdict("PASS")})],
			],
			{resume: true},
		);
		expect(out.code).toBe(PRIOR_BUILD_MISMATCH);
		expect(out.stderr.join("\n")).toContain("drop --resume");
	});

	it("admits an ordinary fresh claim on a child whose verdicts all PASS", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[once(COMMENTS), comments({id: 8801, body: rangeVerdict("PASS")})],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses on 11 when the comments cannot be read — never 'no prior build'", async () => {
		const out = await run(runClaim, [[ISSUE, CLAIMABLE], unclaimed(), [COMMENTS, GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "no"');
	});

	it("refuses on 11 when a comment reaches for a verdict marker and misses — never 'no prior build'", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[
				COMMENTS,
				comments({
					id: 8802,
					body: `review-code: FAIL range:${RANGE} — the child's range`,
				}),
			],
		]);
		// A FAIL missing its content binding is still a reviewer saying no. Counting it and admitting
		// the claim anyway would read a broken verdict as "the reviewer never ran" (#6386, criterion 6).
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain('UNKNOWN, never "no prior build"');
		expect(out.stderr.join("\n")).toContain("#8802");
	});

	it("refuses a malformed marker under --resume too — the flag cannot read what the gate cannot", async () => {
		const out = await run(
			runClaim,
			[
				[ISSUE, CLAIMABLE],
				unclaimed(),
				[
					COMMENTS,
					comments({id: 8803, body: "review-code: SHIPPED range:x..y content:2f1a9c4e0b7d — ?"}),
				],
			],
			{resume: true},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("leaves ordinary discussion alone — only a gate-namespace first line can be malformed", async () => {
		const out = await run(runClaim, [
			[ISSUE, CLAIMABLE],
			unclaimed(),
			[once(COMMENTS), comments({id: 8804, body: "note: this range looks wrong to me"})],
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, comments({id: 9001, body: MINE})],
			[perm("agent"), WRITES],
		]);
		expect(out.code).toBe(0);
	});

	it("does not run for a plan-purpose claim — an epic is not a child", async () => {
		const out = await run(
			runClaim,
			[
				[ISSUE, issue({labels: labelled("type:epic", "p1", "status:triaged")})],
				unclaimed(),
				[POST, POSTED],
				[GET_COMMENT, ECHO],
				[COMMENTS, comments({id: 9001, body: MINE})],
				[perm("agent"), WRITES],
			],
			{purpose: "plan"},
		);
		expect(out.code).toBe(0);
	});
});
