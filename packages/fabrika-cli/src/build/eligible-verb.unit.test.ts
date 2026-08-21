import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BLOCKED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runEligible} from "./eligible-verb.ts";
import {GATEWAY, GH_TOKEN_ENV, issue, NOT_FOUND, served} from "./fixtures.test-support.ts";

const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const PARENT = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4312\/parent$/;
const EDGES = /^GET \S+\/repos\/o\/r\/issues\/4312\/dependencies\/blocked_by\?/;
const BLOCKER = (n: number) => new RegExp(`^GET \\S+/repos/o/r/issues/${n}$`);

/** The `blocked_by` payload, shaped like the endpoint's rows rather than like the parser. */
const edges = (...numbers: ReadonlyArray<number>): HttpReply =>
	served(numbers.map((number) => ({number, state: "open"})));

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(runEligible(options), fakeSeams(script).layer));

/** The same run, with what it spawned and what it requested — how "X was never read" is asserted. */
const runWatched = async (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	const out = await Effect.runPromise(Effect.provide(runEligible(options), seams.layer));
	return {out, calls: seams.calls, requests: seams.requests};
};

const ASSEMBLY = /^git rev-parse --verify --quiet epic\/4300\^\{commit\}$/;
const TRUNK = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;
const MERGE_BASE = /^git merge-base origin\/main [0-9a-f]{40}$/;
/** The bounded walk: two dots, base first — a one-dot rev would not match. */
const ASSEMBLY_LOG = /^git log --format=.* [0-9a-f]{40}\.\.[0-9a-f]{40}$/;
const TIP = "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567";
const BASE = "0123456789abcdef0123456789abcdef01234567";

/** The three reads that bound the assembly range, scripted together — tip, trunk, merge base. */
const RANGE_ENDPOINTS: ReadonlyArray<Scripted> = [
	[ASSEMBLY, okOut(`${TIP}\n`)],
	[TRUNK, served({default_branch: "main"})],
	[MERGE_BASE, okOut(`${BASE}\n`)],
];

/** One `git log` record stream, in the framing `rangeCommits` reads. */
const commitLog = (...messages: ReadonlyArray<string>): ExecResult =>
	okOut(messages.map((message, i) => `${TIP.slice(0, 39)}${i}\x1f${message}\x1e`).join(""));

describe("runEligible", () => {
	it("answers eligible for a standalone issue with no edges, with parent null", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
			[EDGES, edges()],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "eligible", number: 4312, parent: null});
		expect(out.stderr.at(-1)).toBe("build eligible: scanned 0 blocked_by edges; standalone.");
	});

	it("answers eligible when every blocker the graph names is closed", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, served({number: 4300})],
			[EDGES, edges(210)],
			[BLOCKER(210), issue({number: 210, state: "closed"})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).parent).toBe(4300);
		expect(out.stderr.at(-1)).toContain("scanned 1 blocked_by edge");
	});

	/**
	 * The migration's own case (#5913): the prose block is no longer an input, so an edge that exists
	 * only in the graph is the whole gate. A reader still parsing `## Dependencies` would see no row
	 * for this child and answer `eligible`.
	 */
	it("holds back a child blocked by a native edge no prose row names", async () => {
		const {out, requests} = await runWatched([
			[ISSUE, issue()],
			[PARENT, served({number: 4300})],
			[EDGES, edges(210)],
			[BLOCKER(210), issue({number: 210, state: "open"})],
			...RANGE_ENDPOINTS,
			[ASSEMBLY_LOG, commitLog("chore: unrelated")],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by 1 open blocked_by edge: #210.");
		// The parent ledger body is never fetched — the prose block is not an input any more.
		expect(requests.some((request) => request.endsWith("/issues/4300"))).toBe(false);
	});

	it("gates a STANDALONE issue on its own edges — no parent ledger to derive from", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
			[EDGES, edges(210)],
			[BLOCKER(210), issue({number: 210, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by 1 open blocked_by edge: #210.");
	});

	it("names EVERY open edge, not only the first", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
			[EDGES, edges(210, 211)],
			[BLOCKER(210), issue({number: 210, state: "open"})],
			[BLOCKER(211), issue({number: 211, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe(
			"build eligible: blocked by 2 open blocked_by edges: #210, #211.",
		);
	});

	it("counts a blocker the token cannot see as open, never as discharged", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
			[EDGES, edges(210)],
			[BLOCKER(210), NOT_FOUND],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by 1 open blocked_by edge: #210.");
	});

	it("refuses a proven-absent issue on 7", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("build eligible: issue #4312 is proven absent or closed.");
	});

	/**
	 * One case per unreadable input the derivation has (#4920). Each pins `11`: the whole point is that
	 * no read failure anywhere on the path can resolve to "eligible", and a suite that leaves one path
	 * unpinned cannot tell a guard that was removed from one that was never exercised.
	 */
	describe("every unreadable input is 11, never a pass", () => {
		// The parent lookup is scripted to its proven-standalone 404 so this case isolates the issue
		// read: without its guard the derivation would run to completion and answer `eligible`.
		it("the issue itself", async () => {
			const out = await run([
				[ISSUE, GATEWAY],
				[PARENT, NOT_FOUND],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toBe(
				'build eligible: cannot read #4312: GitHub answered HTTP 502 — eligibility is UNKNOWN, never "eligible".',
			);
		});

		it("the parent lookup — never 'standalone'", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stderr.at(-1)).toContain('eligibility is UNKNOWN, never "eligible"');
		});

		it("the edge list — never 'no edges, so not blocked'", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, NOT_FOUND],
				[EDGES, GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain("cannot read the blocked_by edges of #4312");
		});

		it("a 404 on the edge list of an issue already proven open", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, NOT_FOUND],
				[EDGES, NOT_FOUND],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stderr.at(-1)).toContain("answered 404 for an issue already proven open");
		});

		it("a blocker's state, with nothing else proven open", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, NOT_FOUND],
				[EDGES, edges(210)],
				[BLOCKER(210), GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.some((line) => line.includes("cannot read blocker #210"))).toBe(true);
		});
	});

	/**
	 * The epic-run arm (#6063): inside a one-PR run every blocker issue is open by design, so the
	 * closed-state proxy alone makes every later-phase child permanently blocked. Each case pins one
	 * half of the two-source rule — and the negatives pin that the second source only ever discharges
	 * on evidence it actually read.
	 */
	describe("a blocker is discharged by a closed issue OR by a commit on epic/<n>", () => {
		it("discharges an OPEN blocker whose work landed on the assembly branch", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, commitLog("feat(guide): the front door (#210)\n\nPart of #4300")],
			]);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toEqual({answer: "eligible", number: 4312, parent: 4300});
			expect(out.stderr.at(-1)).toContain("origin/main..epic/4300 adds a commit naming #210");
		});

		it("reads no branch at all when every blocker is already closed", async () => {
			const {out, calls} = await runWatched([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "closed"})],
			]);
			expect(out.code).toBe(0);
			expect(calls.some((line) => line.startsWith("git"))).toBe(false);
		});

		it("reads no branch for a standalone issue, which has no assembly branch", async () => {
			const {out, calls} = await runWatched([
				[ISSUE, issue()],
				[PARENT, NOT_FOUND],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
			]);
			expect(out.code).toBe(BLOCKED);
			expect(calls.some((line) => line.startsWith("git"))).toBe(false);
		});

		it("stays blocked when the branch names no commit for the open blocker", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, commitLog("feat(guide): some other child (#211)")],
			]);
			expect(out.code).toBe(BLOCKED);
			expect(out.stderr.at(-1)).toBe("build eligible: blocked by 1 open blocked_by edge: #210.");
		});

		it("never discharges off a branch it could not read — absent epic/<n> stays 16", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
				[ASSEMBLY, errOut("fatal: ambiguous argument 'epic/4300'")],
			]);
			expect(out.code).toBe(BLOCKED);
			expect(out.stdout).toBe("");
			expect(out.stderr.some((line) => line.includes("cannot read epic/4300 in this tree"))).toBe(
				true,
			);
		});

		it("never discharges when the trunk to bound the range against cannot be named", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
				[ASSEMBLY, okOut(`${TIP}\n`)],
				[TRUNK, GATEWAY],
			]);
			expect(out.code).toBe(BLOCKED);
			expect(out.stderr.some((line) => line.includes("cannot name o/r's default branch"))).toBe(
				true,
			);
		});

		it("never discharges when the range has no merge base with the trunk", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), issue({number: 210, state: "open"})],
				[ASSEMBLY, okOut(`${TIP}\n`)],
				[TRUNK, served({default_branch: "main"})],
				[MERGE_BASE, errOut("fatal: refusing to merge unrelated histories")],
			]);
			expect(out.code).toBe(BLOCKED);
			expect(out.stderr.some((line) => line.includes("no merge base with origin/main"))).toBe(true);
		});

		it("never discharges off a log that failed — an unread blocker stays 11", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, served({number: 4300})],
				[EDGES, edges(210)],
				[BLOCKER(210), GATEWAY],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, errOut("fatal: bad object")],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.some((line) => line.includes("cannot read epic/4300 in this tree"))).toBe(
				true,
			);
		});
	});

	it("an unread blocker never masks a proven-open one, and is reported beside it", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
			[EDGES, edges(210, 211)],
			[BLOCKER(210), GATEWAY],
			[BLOCKER(211), issue({number: 211, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by 1 open blocked_by edge: #211.");
		expect(out.stderr.some((line) => line.includes("cannot read blocker #210"))).toBe(true);
	});
});
