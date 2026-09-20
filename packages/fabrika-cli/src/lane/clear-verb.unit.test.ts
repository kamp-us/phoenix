import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {capReached, effectiveCap} from "../cap-clearance.ts";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {CAP_ROUND, RETRY_BUDGET} from "../retry-budget.ts";
import {runClear} from "./clear-verb.ts";
import {recordClearedRound} from "./clearance.ts";
import {
	APPEND_UNKNOWN,
	GRANT_REFUSED,
	GRANT_UNAUTHORIZED,
	LANE_ABSENT,
	LEAKED_PATH,
	PR_AMBIGUOUS,
	RATIONALE_REFUSED,
} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {foldLog, parseLog} from "./fold.ts";
import {compileText} from "./machine.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;
const WHY = "the three FAILs were one finding, now answered";
const NOW = new Date("2026-09-15T07:16:03Z");

const served = (payload: unknown, status = 200): HttpReply => ({
	status,
	body: JSON.stringify(payload),
});

/** The closing-issue edge with no node — the board answer for a lane that has no pull request. */
const NO_CLOSERS: HttpReply = served({
	data: {
		repository: {
			issue: {
				closedByPullRequestsReferences: {
					pageInfo: {hasNextPage: false, endCursor: null},
					nodes: [],
				},
			},
		},
	},
});
const NO_NOMINATIONS: HttpReply = served({total_count: 0, items: []});

const CLOSERS = /^POST \S+\/graphql$/;
const SEARCH = /^GET \S+\/search\/issues\?/;

/** Every lane in this file has no PR unless a case scripts one, so the board says so by default. */
const NO_PULL: ReadonlyArray<Scripted> = [
	[CLOSERS, NO_CLOSERS],
	[SEARCH, NO_NOMINATIONS],
];

const line = (event: string, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-09-10T00:00:00.000Z", ...extra})}\n`;

/** WIP, then a DONE/FAIL round per retry until the budget is spent and the task parks. */
const spent = (): string =>
	[
		line("WIP"),
		...Array.from({length: RETRY_BUDGET + 1}, () => `${line("DONE")}${line("FAIL")}`),
	].join("");

const run = (
	fs: ReturnType<typeof fakeFs>,
	rationale: string | null = WHY,
	script: ReadonlyArray<Scripted> = NO_PULL,
) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runClear({
				root: ROOT,
				lane: "42",
				task: null,
				rationale,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: "o/r"},
				now: () => NOW,
			}),
			Layer.merge(fs.layer, seams.layer),
		),
	).then((outcome) => ({...outcome, requests: seams.requests, bodies: seams.bodies}));
};

/** The retries the lane's own fold reads back off its log — the guard's half of the grant. */
const laneBudgetOf = (log: string): number => {
	const compiled = compileText(coderTemplateText());
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	const parsed = parseLog(log);
	if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
	const fold = foldLog(compiled.lane, parsed.entries);
	if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
	return fold.states.issue?.maxRetries ?? 0;
};

const laneWith = (log: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({files: {[WORKFLOW]: coderTemplateText(), [LOG]: log}, ...extra});

describe("lane clear — the grant", () => {
	it("resumes a legacy cap-2 lane for exactly one repair without rewriting its history", async () => {
		const workflow = JSON.parse(coderTemplateText());
		workflow.machine.context.issue.maxRetries = 2;
		const workflowText = JSON.stringify(workflow).replaceAll("human:budget-spent", "frozen");
		const history = `${line("WIP")}${`${line("DONE")}${line("FAIL")}`.repeat(3)}`;
		const fs = fakeFs({files: {[WORKFLOW]: workflowText, [LOG]: history}});
		const transition = (event: string) =>
			Effect.runPromise(
				Effect.provide(
					runTransition(
						{
							root: ROOT,
							lane: "42",
							task: "issue",
							event,
							cause: null,
							classes: [],
							waitGrant: null,
							parkCause: parkCauseRead(),
							rationale: null,
							repo: "o/r",
							cwd: "/checkout",
							env: {},
						},
						fakeProver().prove,
					),
					fs.layer,
				),
			);
		const state = (log: string) => {
			const compiled = compileText(workflowText);
			if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
			const parsed = parseLog(log);
			if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
			const fold = foldLog(compiled.lane, parsed.entries);
			if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
			return fold.states.issue;
		};

		expect(CAP_ROUND).toBe(4);
		expect((await transition("UNBLOCKED")).code).toBe(36);
		expect(fs.written.size).toBe(0);
		expect(state(history)).toMatchObject({type: "frozen", retries: 2, maxRetries: 2});

		const grant = await run(fs);
		expect(grant.code).toBe(0);
		expect(JSON.parse(grant.stdout)).toMatchObject({answer: "cleared", round: 3, budget: 3});
		const grantedLog = fs.written.get(LOG) ?? "";
		expect(grantedLog.slice(0, history.length)).toBe(history);
		expect(state(grantedLog)).toMatchObject({type: "frozen", retries: 2, maxRetries: 3});
		expect(state(`${grantedLog}${line("CLEARED", {round: 3})}`)).toEqual(state(grantedLog));

		const repeated = await Effect.runPromise(
			Effect.provide(recordClearedRound({root: ROOT, lane: "42"}, "issue", 3), fs.layer),
		);
		expect(repeated._tag).toBe("AlreadyHeld");
		expect((await run(fs)).code).toBe(GRANT_REFUSED);
		expect(fs.written.get(LOG)).toBe(grantedLog);

		const resumed = await transition("UNBLOCKED");
		expect(resumed.code).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({current: {pipeline: {issue: "review"}}});
		expect((await transition("FAIL")).code).toBe(0);
		expect(state(fs.written.get(LOG) ?? "")).toMatchObject({
			type: "build",
			retries: 3,
			maxRetries: 3,
		});
		expect((await transition("DONE")).code).toBe(0);
		expect((await transition("FAIL")).code).toBe(0);
		expect(state(fs.written.get(LOG) ?? "")).toMatchObject({
			type: "frozen",
			retries: 3,
			maxRetries: 3,
		});
		const spentLog = fs.written.get(LOG) ?? "";
		expect((await transition("UNBLOCKED")).code).toBe(36);
		expect(fs.written.get(LOG)).toBe(spentLog);
		expect(spentLog.slice(0, history.length)).toBe(history);
		expect(fs.written.has(WORKFLOW)).toBe(false);
	});

	it("appends the derived round with its rationale and answers the new budget", async () => {
		const fs = laneWith(spent());

		const out = await run(fs);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "cleared",
			task: "issue",
			round: CAP_ROUND,
			budget: RETRY_BUDGET + 1,
			rationale: WHY,
		});
		const appended = (fs.written.get(LOG) ?? "").trim().split("\n");
		expect(JSON.parse(appended[appended.length - 1] ?? "")).toMatchObject({
			task: "issue",
			event: "ISSUE.CLEARED",
			round: CAP_ROUND,
			rationale: WHY,
		});
	});

	it("grants one round per call — the second call derives the round after the first", async () => {
		const fs = laneWith(
			`${spent()}${line("CLEARED", {round: CAP_ROUND})}${line("UNBLOCKED")}${line("FAIL")}`,
		);

		expect(JSON.parse((await run(fs)).stdout)).toMatchObject({
			answer: "cleared",
			round: CAP_ROUND + 1,
		});
	});
});

describe("lane clear — the refusals, each with the log unappended", () => {
	it("refuses a task that still has budget to spend", async () => {
		const fs = laneWith(line("WIP"));

		const out = await run(fs);
		expect(out.code).toBe(GRANT_REFUSED);
		expect(out.stderr.join(" ")).toContain("has budget to spend");
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("refuses an absent rationale — a grant nobody can review is not one", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, null);
		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(out.stderr.join(" ")).toContain("absent");
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("refuses a blank rationale for the same reason, before it reads the lane at all", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, "   ");
		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(out.stderr.join(" ")).toContain("blank");
	});

	it("refuses an absent lane", async () => {
		const fs = fakeFs({files: {}});

		expect((await run(fs)).code).toBe(LANE_ABSENT);
	});

	it("reports a failed append as UNKNOWN, never as a cleared round", async () => {
		const fs = laneWith(spent(), {unwritable: [LOG]});

		const out = await run(fs);
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stderr.join(" ")).toContain("NOT cleared");
	});
});

/**
 * The PR-side half — the budget a builder actually reads.
 *
 * The lane's own grant was never the one that stopped a repair: `build verdicts` folds `capReached`
 * off the PR's FAIL rounds, so a driver that cleared only the lane dispatched a builder that refused
 * without touching the branch. These cases pin that one `lane clear` now buys both.
 */
describe("lane clear — the PR-side grant", () => {
	const PR = 99;
	const PULL = new RegExp(`^GET \\S+/repos/o/r/pulls/${PR}$`);
	const COMMENTS = new RegExp(`^GET \\S+/repos/o/r/issues/${PR}/comments`);
	const POST = new RegExp(`^POST \\S+/repos/o/r/issues/${PR}/comments`);
	const GET_COMMENT = /^GET \S+\/repos\/o\/r\/issues\/comments\/\d+$/;
	const VIEWER = /^GET https:\/\/api\.github\.com\/user$/;
	const CONFIG = /^GET \S+\/repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
	const PERMISSION = /^GET \S+\/repos\/o\/r\/collaborators\/usirin\/permission/;

	const closingEdge = (...numbers: ReadonlyArray<number>): HttpReply =>
		served({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: numbers.map((number) => ({
								number,
								url: `https://forge.example/o/r/pull/${number}`,
								state: "OPEN",
							})),
						},
					},
				},
			},
		});

	const openPull = served({
		number: PR,
		state: "open",
		head: {sha: "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1"},
		base: {ref: "main"},
		body: "Fixes #42\n\n## Deviations\nNone.\n",
		changed_files: 2,
		comments: 0,
		html_url: `https://forge.example/o/r/pull/${PR}`,
	});

	/** One graded head per round, so the PR's own budget reads as spent. */
	const failRounds = (rounds: number): ReadonlyArray<Record<string, unknown>> =>
		Array.from({length: rounds}, (_unused, index) => ({
			id: index + 1,
			body: `review-code: FAIL @ ${index + 1}c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f — round ${index + 1}`,
			user: {login: "agent"},
			created_at: `2026-09-1${index + 1}T00:00:00Z`,
		}));

	/** A request that WROTE on the PR. The comment list reads the same URL, so the method decides. */
	const wrote = (request: string): boolean =>
		request.startsWith("POST") && request.includes(`/issues/${PR}/comments`);

	const CONFIGURED: HttpReply = {status: 200, body: '{"capClearAuthors": ["@usirin"]}'};
	const POSTED: HttpReply = served({id: 900, html_url: "https://forge.example/c"}, 201);

	const board = (
		rounds: number,
		overrides: ReadonlyArray<Scripted> = [],
	): ReadonlyArray<Scripted> => [
		...overrides,
		[CLOSERS, closingEdge(PR)],
		[SEARCH, NO_NOMINATIONS],
		[PULL, openPull],
		[COMMENTS, served(failRounds(rounds))],
		[VIEWER, served({login: "usirin"})],
		[CONFIG, CONFIGURED],
		[PERMISSION, served({permission: "admin"})],
		[POST, POSTED],
		[
			GET_COMMENT,
			served({
				body: `cap-cleared: round ${CAP_ROUND} · 2026-09-15T07:16:03Z\n`,
				user: {login: "usirin"},
			}),
		],
	];

	it("posts the rationale as the authorization, then the marker, in that order", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, WHY, board(CAP_ROUND));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "cleared",
			round: CAP_ROUND,
			pr: {number: PR, answer: "cleared", round: CAP_ROUND, cap: CAP_ROUND + 1},
		});
		const posted = out.bodies.filter((_body, index) => wrote(out.requests[index] ?? ""));
		expect(posted[0]).toContain(WHY);
		expect(posted[0]).toContain("2026-09-15");
		expect(posted[1]).toContain(`cap-cleared: round ${CAP_ROUND}`);
	});

	it("leaves a builder's PR-side budget spendable, with no `build clear` behind it", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, WHY, board(CAP_ROUND));
		const granted = JSON.parse(out.stdout).pr;

		// What `build verdicts` folds: the round the grant names raises the cap past the rounds the
		// PR has burned, so `capReached` reads false and the builder repairs instead of escalating.
		expect(capReached(CAP_ROUND, [granted.round])).toBe(false);
		expect(effectiveCap([granted.round])).toBe(granted.cap);
		// And the lane's own guard agrees, off the same one call.
		expect(laneBudgetOf(fs.written.get(LOG) ?? "")).toBe(RETRY_BUDGET + 1);
	});

	it("refuses whole when the account may not clear a round, log unappended", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, WHY, board(CAP_ROUND, [[VIEWER, served({login: "someone-else"})]]));

		expect(out.code).toBe(GRANT_UNAUTHORIZED);
		expect(out.stderr.join(" ")).toContain("grant-author set");
		expect(fs.written.get(LOG)).toBeUndefined();
		expect(out.requests.some(wrote)).toBe(false);
	});

	it("reads an honoured grant already at that round as held, posting nothing", async () => {
		const fs = laneWith(spent());
		const standing = [
			...failRounds(CAP_ROUND),
			{
				id: 800,
				body: "Driver grant · lane 42 · task issue · 2026-09-14\n\nthe earlier round\n",
				user: {login: "usirin"},
				created_at: "2026-09-14T00:00:00Z",
			},
			{
				id: 801,
				body: `cap-cleared: round ${CAP_ROUND} · 2026-09-14T00:00:01Z\n`,
				user: {login: "usirin"},
				created_at: "2026-09-14T00:00:01Z",
			},
		];

		const out = await run(fs, WHY, [
			[CLOSERS, closingEdge(PR)],
			[SEARCH, NO_NOMINATIONS],
			[PULL, openPull],
			[COMMENTS, served(standing)],
			[CONFIG, CONFIGURED],
			[PERMISSION, served({permission: "admin"})],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).pr).toMatchObject({answer: "held", round: CAP_ROUND});
		expect(out.requests.some(wrote)).toBe(false);
	});

	it("says so and grants the lane anyway when the PR's own budget is not spent", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, WHY, board(1));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "cleared",
			pr: {number: PR, answer: "unspent", round: 1},
		});
		expect(out.stderr.join(" ")).toContain("budget is not spent");
		expect(out.requests.some(wrote)).toBe(false);
	});

	it("refuses a rationale carrying a machine-local path before it reads the board", async () => {
		const fs = laneWith(spent());

		const out = await run(
			fs,
			"the fix is in /Users/someone/checkout/src/index.ts",
			board(CAP_ROUND),
		);

		expect(out.code).toBe(LEAKED_PATH);
		expect(fs.written.get(LOG)).toBeUndefined();
		expect(out.requests).toEqual([]);
	});

	it("refuses when two open PRs link the issue — which carries the budget is not derivable", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, WHY, [
			[CLOSERS, closingEdge(PR, PR + 1)],
			[SEARCH, NO_NOMINATIONS],
			[PULL, openPull],
			[
				new RegExp(`^GET \\S+/repos/o/r/pulls/${PR + 1}$`),
				served({...JSON.parse(openPull.body), number: PR + 1}),
			],
		]);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("grants the lane half alone where no pull request carries the task", async () => {
		const fs = laneWith(spent());

		const out = await run(fs);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).pr).toBeNull();
		expect(out.stderr.join(" ")).toContain("no PR-side budget to grant");
	});
});
