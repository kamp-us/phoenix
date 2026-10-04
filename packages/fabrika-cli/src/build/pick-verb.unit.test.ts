import {Effect, Layer} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeHttp,
	fakeSeams,
	fakeShell,
	type HttpReply,
	linkNext,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PROJECT_SCOPE_FIX} from "../io/projects.ts";
import {
	blankProject,
	type FakeProject,
	type FakeProjectsOptions,
	fakeProjects,
} from "../io/projects-fake.test-support.ts";
import {ROADMAP_FILE} from "../triage/roadmap.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	blockedBy,
	CRITERIA_BODY,
	campaignsTable,
	candidatePage,
	GATEWAY,
	GH_TOKEN_ENV,
	issue,
	NO_BLOCKERS,
	NO_TABLE,
	NOT_FOUND,
	served,
} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";

const bucket = (priority: string) =>
	new RegExp(
		`^GET https://api\\.github\\.com/repos/o/r/issues\\?state=open&labels=status%3Atriaged%2C${priority}`,
	);

const EMPTY = served([]);
const TRIAGED = ["status:triaged", "ready-for:agent", "type:bug"];

/** A report-shaped body — prose only, no contract anywhere. The shape a filed report arrives in. */
const REPORT_BODY = "## Summary\n\nsomething is off.\n\n## Pointers\n\n- a file\n";

const NOW = new Date("2026-09-30T12:00:00Z");

const options = {
	repo: null,
	limit: 20,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
	now: () => NOW,
};

/** No `.fabrika.jsonc` and no `ROADMAP.md`: the zero-config repository. */
const NO_CONFIG = fakeFs({files: {}});

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fs = NO_CONFIG,
) =>
	Effect.runPromise(
		Effect.provide(
			runPick({...options, ...overrides}),
			Layer.merge(fakeSeams([...script, NO_BLOCKERS, NO_TABLE]).layer, fs.layer),
		),
	);

const pool = (out: {stdout: string}) =>
	JSON.parse(out.stdout).pool as ReadonlyArray<{number: number}>;

/** The reason histogram `excluded` collapses to — counts, never rows. */
const excluded = (out: {stdout: string}) =>
	JSON.parse(out.stdout).excluded as Readonly<Record<string, number>>;

describe("runPick", () => {
	it("ranks p0 before p1 before p2, and milestone order inside a bucket", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
					{number: 400, labels: [...TRIAGED, "p0"], milestone: null},
				),
			],
			[bucket("p1"), candidatePage({number: 300, labels: [...TRIAGED, "p1"]})],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 400, 300]);
	});

	it("excludes an issue with NO ready-for: label — absence is an unknown audience (#4780)", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: ["status:triaged", "type:bug", "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out)).toEqual([]);
		expect(excluded(out)).toEqual({"audience-not-agent": 1});
	});

	/**
	 * The pool is where a contract-less issue is cheapest to catch: the alternative is `review
	 * criteria` finding it after a branch, a build, a push, a PR and a CI run.
	 */
	it("excludes a candidate whose body carries no acceptance-criteria block, with its axis", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"], body: REPORT_BODY})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(0);
		expect(pool(out)).toEqual([]);
		expect(excluded(out)).toEqual({"no-acceptance-criteria": 1});
	});

	it("excludes a candidate whose criteria heading has drifted — malformed is not a contract", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage({
					number: 500,
					labels: [...TRIAGED, "p0"],
					body: CRITERIA_BODY.replace("### Acceptance", "## Acceptance"),
				}),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(excluded(out)).toEqual({"no-acceptance-criteria": 1});
	});

	it("admits a criteria-bearing candidate — the axis excludes the contract-less one only", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: [...TRIAGED, "p0"]},
					{number: 501, labels: [...TRIAGED, "p0"], body: REPORT_BODY},
				),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual({"no-acceptance-criteria": 1});
	});

	/**
	 * The counts are printed so an operator can tell a working fence from a broken one, which they
	 * cannot do if a shortened pool is attributed to an axis that did not refuse it.
	 */
	it("splits the excluded count by axis — the criteria axis is not the admission test's", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: [...TRIAGED, "p0"], body: REPORT_BODY},
					{number: 501, labels: ["status:triaged", "p0"]},
				),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.stderr.join("\n")).toContain(
			"0 candidate(s) survived the filter, 2 excluded — 1 by the admission test, 1 for no acceptance-criteria block, 0 on the blocked_by graph.",
		);
	});

	/**
	 * The exemplar collapse: `excluded` is evidence, so many rows print as counts, while
	 * `pool` is the answer and is untouched. The measured board printed 266 rows carrying two reasons.
	 */
	it("collapses many exclusions to a reason histogram and leaves the pool whole", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: [...TRIAGED, "p0"]},
					...[501, 502, 503].map((number) => ({
						number,
						labels: ["status:triaged", "type:bug", "p0"],
					})),
					...[504, 505].map((number) => ({
						number,
						labels: [...TRIAGED, "p0"],
						body: REPORT_BODY,
					})),
				),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual({"audience-not-agent": 3, "no-acceptance-criteria": 2});
		expect(Object.keys(excluded(out))).toEqual(["audience-not-agent", "no-acceptance-criteria"]);
	});

	it("excludes an assigned issue — assignment keeps a human's document out (#4764)", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage({number: 500, labels: [...TRIAGED, "p0"], assignees: ["usirin"]}),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out)).toEqual([]);
	});

	it("excludes type:decision and type:epic, and pull requests", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: ["status:triaged", "ready-for:agent", "type:epic", "p0"]},
					{number: 501, labels: [...TRIAGED, "p0"], pull: true},
				),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out)).toEqual([]);
	});

	/** One lane-labelled, milestone-less candidate; whether the label is a home is the repo's call. */
	const LANE_CANDIDATE: ReadonlyArray<Scripted> = [
		[
			bucket("p0"),
			candidatePage({number: 500, labels: [...TRIAGED, "p0", "axis:pipeline-hardening"]}),
		],
		[bucket("p1"), EMPTY],
		[bucket("p2"), EMPTY],
	];

	it("names a declared standing lane as the home when there is no milestone", async () => {
		const out = await run(
			LANE_CANDIDATE,
			{},
			fakeFs({
				files: {
					"/repo/.fabrika.jsonc": JSON.stringify({
						boardVocabulary: {standingLanes: ["axis:pipeline-hardening"]},
					}),
				},
			}),
		);
		expect(JSON.parse(out.stdout).pool[0].home).toBe("axis:pipeline-hardening");
	});

	it("reads no home off that label in a repo that declares no lane", async () => {
		const out = await run(LANE_CANDIDATE);
		expect(JSON.parse(out.stdout).pool[0].home).toBeNull();
	});

	it("refuses a lane declaration nobody could read on 11 — never ranked as a repo with no lane", async () => {
		const seams = fakeSeams([...LANE_CANDIDATE, NO_BLOCKERS, NO_TABLE]);
		const fs = fakeFs({
			files: {"/repo/.fabrika.jsonc": JSON.stringify({boardVocabulary: "wayfinder:backlog"})},
		});
		const out = await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(seams.layer, fs.layer)),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(
			"build pick: cannot read .fabrika.jsonc's board vocabulary",
		);
		expect(out.stderr.at(-1)).toContain(
			"which labels this board runs on is UNKNOWN, never the shipped names",
		);
		expect(seams.requests.filter((line) => line.includes("labels=status%3Atriaged"))).toEqual([]);
	});

	describe("a repo that renamed its triaged status", () => {
		const RENAMED = fakeFs({
			files: {
				"/repo/.fabrika.jsonc": JSON.stringify({
					boardVocabulary: {statuses: {triaged: "state:ready"}},
				}),
			},
		});
		const renamedBucket = (priority: string) =>
			new RegExp(
				`^GET https://api\\.github\\.com/repos/o/r/issues\\?state=open&labels=state%3Aready%2C${priority}`,
			);
		const READY = ["state:ready", "ready-for:agent", "type:bug"];

		/**
		 * The reported failure, end to end: the work is labelled with the renamed status, and a pool
		 * queried under the shipped name answered empty on exit 0. Only the renamed query is scripted,
		 * so a read under `status:triaged` has no answer to come back empty from.
		 */
		it("returns the issues carrying the renamed label instead of an empty pool", async () => {
			const out = await run(
				[
					[renamedBucket("p0"), candidatePage({number: 500, labels: [...READY, "p0"]})],
					[renamedBucket("p1"), EMPTY],
					[renamedBucket("p2"), EMPTY],
				],
				{},
				RENAMED,
			);
			expect(out.code).toBe(0);
			expect(pool(out).map((row) => row.number)).toEqual([500]);
		});

		it("keeps out an issue still carrying a second status under the renamed board", async () => {
			const out = await run(
				[
					[
						renamedBucket("p0"),
						candidatePage({number: 500, labels: [...READY, "status:needs-info", "p0"]}),
					],
					[renamedBucket("p1"), EMPTY],
					[renamedBucket("p2"), EMPTY],
				],
				{},
				RENAMED,
			);
			expect(out.code).toBe(0);
			expect(pool(out)).toEqual([]);
		});
	});

	it("prints an empty pool as a FACT on exit 0, with the scanned counts beside it", async () => {
		const out = await run([
			[bucket("p0"), EMPTY],
			[bucket("p1"), EMPTY],
			[bucket("p2"), candidatePage({number: 9, labels: ["status:triaged", "p2"]})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			pool: [],
			excluded: {"audience-not-agent": 1},
			unread: 0,
			scanned: {p0: 0, p1: 0, p2: 1},
			bets: {state: "none"},
		});
	});

	it("refuses a failed bucket read on 11 — a 5xx on p0 never reads as 'no p0s'", async () => {
		const out = await run([
			[bucket("p0"), GATEWAY],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build pick: cannot read the p0 bucket: GitHub answered HTTP 502: Bad gateway — the pool is UNKNOWN, never partial.",
		);
	});

	it("paginates every bucket", async () => {
		const seams = fakeSeams([
			[bucket("p0"), EMPTY],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			NO_TABLE,
		]);
		await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(seams.layer, NO_CONFIG.layer)),
		);
		expect(seams.requests.filter((line) => line.includes("per_page=100"))).toHaveLength(3);
	});

	it("refuses a non-positive --limit as a plain usage error", async () => {
		const out = await run([], {limit: 0});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe('build pick: --limit "0" is not a positive integer.');
	});

	// A full page that still declares a `next` is the truncation this transport can produce: the walk
	// reaches the page cap holding rows and no terminal page, so the bucket's completeness is unproven
	// and the pool refuses rather than answering "no p0s" over a board it only partly read.
	it("refuses a bucket whose pagination never reaches a terminal page on 11 — a partial board never reads as the whole board", async () => {
		const page = {
			...candidatePage({number: 1, labels: [...TRIAGED, "p0"]}),
			headers: linkNext("https://api.github.com/repos/o/r/issues?page=2"),
		};
		const out = await run([
			[bucket("p0"), page],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("stopped at the page cap with another page outstanding");
		expect(out.stderr.at(-1)).toContain("the pool is UNKNOWN, never partial");
	});

	it("admits an issue whose milestone no active campaign pins — a campaign never excludes", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidatePage(
						{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
						{number: 400, labels: [...TRIAGED, "p0"], milestone: 39},
						{number: 300, labels: [...TRIAGED, "p0"], milestone: null},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([400, 500, 300]);
		expect(excluded(out)).toEqual({});
	});

	it("never reads the campaigns table — a malformed one refuses nothing", async () => {
		const out = await run(
			[
				[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"], milestone: 39})],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44).replace("| active |", "| activ |")}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(out.stderr.join("\n")).not.toContain("campaigns");
	});

	it("says on stderr that no table project was found, and keeps its own order", async () => {
		const out = await run([
			[bucket("p0"), EMPTY],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.stderr.at(-1)).toBe(
			'build pick: bets: no table project — none is configured, and none titled "r table" is linked to o/r; the pool is in its own order.',
		);
	});

	it("caps the pool at --limit after ranking", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidatePage(
						{number: 1, labels: [...TRIAGED, "p0"]},
						{number: 2, labels: [...TRIAGED, "p0"]},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{limit: 1},
		);
		expect(pool(out).map((row) => row.number)).toEqual([1]);
	});
});

/**
 * The exclusion the `blocked_by` graph gives the pool. The `status:blocked` label it replaces was
 * dropped by accident — the two-`status:`-label hygiene test excluded those issues with no reason
 * printed, and with the label retired that accident stops firing at all.
 */
describe("runPick — the blocked_by graph", () => {
	const edges = (n: number) =>
		new RegExp(`^GET \\S+/repos/o/r/issues/${n}/dependencies/blocked_by`);
	const blocker = (n: number) => new RegExp(`^GET \\S+/repos/o/r/issues/${n}$`);
	const parent = (n: number) => new RegExp(`^GET \\S+/repos/o/r/issues/${n}/parent$`);

	it("excludes a candidate with an open blocker, with `blocked` as its named reason", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			[edges(500), blockedBy(210)],
			[blocker(210), issue({number: 210, state: "open"})],
			[parent(500), NOT_FOUND],
		]);
		expect(out.code).toBe(0);
		expect(pool(out)).toEqual([]);
		expect(excluded(out)).toEqual({blocked: 1});
		expect(out.stderr.join("\n")).toContain("#500 is blocked by #210");
	});

	it("keeps a candidate whose every blocker is closed", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			[edges(500), blockedBy(210)],
			[blocker(210), issue({number: 210, state: "closed"})],
		]);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual({});
	});

	it("excludes a candidate whose edge list could not be read, naming why on stderr", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			[edges(500), GATEWAY],
		]);
		expect(out.code).toBe(0);
		expect(pool(out)).toEqual([]);
		expect(excluded(out)).toEqual({unreadable: 1});
		expect(out.stderr.join("\n")).toContain("cannot read the blocked_by edges of #500");
	});

	/**
	 * The pool used to answer the pre-discharge question while `build eligible` and `build claim`
	 * answered the discharged one, so one edge got three answers and a buildable child read as
	 * blocked to anyone browsing.
	 */
	describe("the assembly-branch discharge", () => {
		const CHILD = 500;
		const BLOCKER = 210;
		const EPIC = 6767;
		const ASSEMBLY = new RegExp(`^git rev-parse --verify --quiet epic/${EPIC}\\^\\{commit\\}$`);
		const TRUNK = /^GET \S+\/repos\/o\/r$/;
		const MERGE_BASE = /^git merge-base origin\/main [0-9a-f]{40}$/;
		const ASSEMBLY_LOG = /^git log --format=.* [0-9a-f]{40}\.\.[0-9a-f]{40}$/;
		const TIP = "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567";
		const BASE = "0123456789abcdef0123456789abcdef01234567";

		/** The three reads that bound the assembly range — tip, trunk, merge base. */
		const RANGE_ENDPOINTS: ReadonlyArray<Scripted> = [
			[ASSEMBLY, okOut(`${TIP}\n`)],
			[TRUNK, served({default_branch: "main"})],
			[MERGE_BASE, okOut(`${BASE}\n`)],
		];

		const commitLog = (...messages: ReadonlyArray<string>): ExecResult =>
			okOut(messages.map((message, i) => `${TIP.slice(0, 39)}${i}\x1f${message}\x1e`).join(""));

		/** One p0 child with one open blocker on the board, and nothing in the other two buckets. */
		const BOARD: ReadonlyArray<Scripted> = [
			[bucket("p0"), candidatePage({number: CHILD, labels: [...TRIAGED, "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			[edges(CHILD), blockedBy(BLOCKER)],
			[blocker(BLOCKER), issue({number: BLOCKER, state: "open"})],
		];

		it("admits a child whose blocker's work landed on the parent epic's assembly branch", async () => {
			const out = await run([
				...BOARD,
				[parent(CHILD), served({number: EPIC})],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, commitLog(`feat(tracer): the first tracer (#${BLOCKER})`)],
			]);
			expect(out.code).toBe(0);
			expect(pool(out).map((row) => row.number)).toEqual([CHILD]);
			expect(excluded(out)).toEqual({});
			expect(out.stderr.join("\n")).toContain(`adds a commit that lands #${BLOCKER}`);
		});

		it("still excludes an open edge the branch does not carry — discharge only ever admits", async () => {
			const out = await run([
				...BOARD,
				[parent(CHILD), served({number: EPIC})],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, commitLog("chore(epic): assembly branch cut (#6768)")],
			]);
			expect(pool(out)).toEqual([]);
			expect(excluded(out)).toEqual({blocked: 1});
			expect(out.stderr.join("\n")).toContain(`#${CHILD} is blocked by #${BLOCKER}`);
		});

		it("keeps the board's state when the assembly branch cannot be read", async () => {
			const out = await run([
				...BOARD,
				[parent(CHILD), served({number: EPIC})],
				[ASSEMBLY, errOut(`fatal: ambiguous argument 'epic/${EPIC}'`)],
			]);
			expect(pool(out)).toEqual([]);
			expect(excluded(out)).toEqual({blocked: 1});
			expect(out.stderr.join("\n")).toContain(`cannot read epic/${EPIC} in this tree`);
		});

		it("leaves a parentless candidate exactly as the board read it — no branch is derivable", async () => {
			const out = await run([...BOARD, [parent(CHILD), NOT_FOUND]]);
			expect(pool(out)).toEqual([]);
			expect(excluded(out)).toEqual({blocked: 1});
			expect(out.stderr.join("\n")).not.toContain("assembly branch");
		});

		it("excludes a candidate whose parent could not be read — an unread parent is never an admission", async () => {
			const out = await run([...BOARD, [parent(CHILD), GATEWAY]]);
			expect(pool(out)).toEqual([]);
			expect(excluded(out)).toEqual({unreadable: 1});
			expect(out.stderr.join("\n")).toContain(`the parent of #${CHILD} could not be read`);
		});

		/** The trunk name is one repository fact, so one pick reads it once however many children ask. */
		it("reads the default branch once for two epic children with open blockers", async () => {
			const SECOND = 501;
			const seams = fakeSeams([
				[
					bucket("p0"),
					candidatePage(
						{number: CHILD, labels: [...TRIAGED, "p0"]},
						{number: SECOND, labels: [...TRIAGED, "p0"]},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
				[edges(CHILD), blockedBy(BLOCKER)],
				[edges(SECOND), blockedBy(BLOCKER)],
				[blocker(BLOCKER), issue({number: BLOCKER, state: "open"})],
				[parent(CHILD), served({number: EPIC})],
				[parent(SECOND), served({number: EPIC})],
				...RANGE_ENDPOINTS,
				[ASSEMBLY_LOG, commitLog("chore(epic): assembly branch cut (#6768)")],
				NO_BLOCKERS,
				NO_TABLE,
			]);
			const out = await Effect.runPromise(
				Effect.provide(runPick(options), Layer.merge(seams.layer, NO_CONFIG.layer)),
			);
			expect(excluded(out)).toEqual({blocked: 2});
			expect(seams.calls.filter((line) => /rev-parse --verify/.test(line))).toHaveLength(2);
			expect(seams.requests.filter((line) => TRUNK.test(line))).toHaveLength(1);
		});

		/** The cost fence: an all-clear pool pays for neither the parent resolve nor the branch read. */
		it("resolves no parent and reads no branch for a pool whose candidates are all clear", async () => {
			const seams = fakeSeams([
				[bucket("p0"), candidatePage({number: CHILD, labels: [...TRIAGED, "p0"]})],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
				NO_BLOCKERS,
				NO_TABLE,
			]);
			const out = await Effect.runPromise(
				Effect.provide(runPick(options), Layer.merge(seams.layer, NO_CONFIG.layer)),
			);
			expect(pool(out).map((row) => row.number)).toEqual([CHILD]);
			expect(seams.requests.some((line) => parent(CHILD).test(line))).toBe(false);
			expect(seams.calls.some((line) => /rev-parse/.test(line))).toBe(false);
		});
	});

	/** The graph read is last because it is the only axis that costs a call — nothing else does. */
	it("reads no edges for a candidate an earlier axis already excluded", async () => {
		const shell = fakeSeams([
			[
				bucket("p0"),
				candidatePage(
					{number: 500, labels: ["status:triaged", "type:bug", "p0"]},
					{number: 501, labels: [...TRIAGED, "p0"], body: REPORT_BODY},
				),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			NO_TABLE,
		]);
		const out = await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(shell.layer, NO_CONFIG.layer)),
		);
		expect(out.code).toBe(0);
		expect(shell.requests.some((line) => /dependencies\/blocked_by/.test(line))).toBe(false);
	});
});

/**
 * The graph read walks the ranked pool and stops once `--limit` candidates survive it, so a pick's
 * cost tracks `--limit` rather than the triaged backlog.
 */
describe("runPick — the early stop", () => {
	const edges = (n: number) =>
		new RegExp(`^GET \\S+/repos/o/r/issues/${n}/dependencies/blocked_by`);
	const EDGE_READ = /dependencies\/blocked_by/;

	const agentReady = (priority: string, numbers: ReadonlyArray<number>) =>
		candidatePage(...numbers.map((number) => ({number, labels: [...TRIAGED, priority]})));

	const range = (from: number, count: number) =>
		Array.from({length: count}, (_, index) => from + index);

	const runCounting = (script: ReadonlyArray<Scripted>, limit: number) =>
		Effect.gen(function* () {
			const seams = fakeSeams([...script, NO_BLOCKERS, NO_TABLE]);
			const out = yield* Effect.provide(
				runPick({...options, limit}),
				Layer.merge(seams.layer, NO_CONFIG.layer),
			);
			return {out, requests: seams.requests};
		}).pipe(Effect.runPromise);

	it("reads exactly --limit edge lists over 100 admitted, unblocked candidates", async () => {
		const {out, requests} = await runCounting(
			[
				[bucket("p0"), EMPTY],
				[bucket("p1"), agentReady("p1", range(1000, 60))],
				[bucket("p2"), agentReady("p2", range(2000, 40))],
			],
			5,
		);
		expect(out.code).toBe(0);
		expect(requests.filter((line) => EDGE_READ.test(line))).toHaveLength(5);
		expect(pool(out).map((row) => row.number)).toEqual(range(1000, 5));
		expect(JSON.parse(out.stdout).unread).toBe(95);
		expect(excluded(out)).toEqual({});
		expect(out.stderr[0]).toContain("95 admitted candidate(s) left unread once --limit 5 filled.");
	});

	it("excludes blocked and unreadable candidates ahead of the stop and keeps walking to fill --limit", async () => {
		const {out, requests} = await runCounting(
			[
				[bucket("p0"), agentReady("p0", range(1, 10))],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
				[edges(1), blockedBy(210)],
				[/^GET \S+\/repos\/o\/r\/issues\/210$/, issue({number: 210, state: "open"})],
				[/^GET \S+\/repos\/o\/r\/issues\/1\/parent$/, NOT_FOUND],
				[edges(2), GATEWAY],
			],
			3,
		);
		expect(pool(out).map((row) => row.number)).toEqual([3, 4, 5]);
		expect(excluded(out)).toEqual({blocked: 1, unreadable: 1});
		expect(JSON.parse(out.stdout).unread).toBe(5);
		expect(requests.filter((line) => EDGE_READ.test(line))).toHaveLength(5);
		expect(out.stderr.join("\n")).toContain("#1 is blocked by #210");
		expect(out.stderr.join("\n")).toContain("cannot read the blocked_by edges of #2");
	});

	it("counts nothing unread when the ranked pool runs out before --limit fills", async () => {
		const {out} = await runCounting(
			[
				[bucket("p0"), agentReady("p0", [1, 2])],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			5,
		);
		expect(pool(out).map((row) => row.number)).toEqual([1, 2]);
		expect(JSON.parse(out.stdout).unread).toBe(0);
	});
});

/**
 * Bets first. The REST reads go to the scripted seam and the Projects reads to the stateful
 * Projects fake, split on the GraphQL endpoint, so one pick runs both the way production does.
 */
describe("runPick — bets first", () => {
	/** NOW is a Wednesday, so under the shipped Monday table the table in force is Sep 28. */
	const THIS_TABLE = "2026-09-28";
	const LAST_TABLE = "2026-09-21";

	const STAGE = {proposed: "st-proposed", bet: "st-bet"};
	const SECTION = {Tails: "se-tails", Customers: "se-customers", "New bets": "se-new"};

	/** The table project `table setup` would leave, holding the given rows. */
	const table = (
		rows: ReadonlyArray<{
			readonly issue: number;
			readonly stage: keyof typeof STAGE;
			readonly section: keyof typeof SECTION;
			readonly tableDay?: string;
		}>,
		over: Partial<FakeProject> = {},
	): FakeProject =>
		blankProject({
			number: 7,
			owner: "o",
			title: "r table",
			fields: [
				{
					id: "F_stage",
					name: "Stage",
					dataType: "SINGLE_SELECT",
					options: Object.entries(STAGE).map(([name, id]) => ({
						id,
						name,
						color: "GRAY",
						description: "",
					})),
				},
				{
					id: "F_section",
					name: "Section",
					dataType: "SINGLE_SELECT",
					options: Object.entries(SECTION).map(([name, id]) => ({
						id,
						name,
						color: "GRAY",
						description: "",
					})),
				},
				{id: "F_day", name: "Table day", dataType: "DATE"},
			],
			items: rows.map((row, index) => ({
				id: `PVTI_${index}`,
				contentId: `I_${row.issue}`,
				number: row.issue,
				values: {
					F_stage: {singleSelectOptionId: STAGE[row.stage]},
					F_section: {singleSelectOptionId: SECTION[row.section]},
					F_day: {date: row.tableDay ?? THIS_TABLE},
				},
			})),
			...over,
		});

	/** One HttpClient: GraphQL to the Projects fake, everything else to the scripted REST seam. */
	const routed = (
		rest: Layer.Layer<HttpClient.HttpClient>,
		graph: Layer.Layer<HttpClient.HttpClient>,
	): Layer.Layer<HttpClient.HttpClient> => {
		const clientOf = (layer: Layer.Layer<HttpClient.HttpClient>) =>
			Effect.runSync(
				Effect.provide(
					Effect.gen(function* () {
						return yield* HttpClient.HttpClient;
					}),
					layer,
				),
			);
		const restClient = clientOf(rest);
		const graphClient = clientOf(graph);
		return Layer.succeed(HttpClient.HttpClient)(
			HttpClient.make((request, url) =>
				(url.pathname === "/graphql" ? graphClient : restClient).execute(request),
			),
		);
	};

	const runWithGraph = (
		script: ReadonlyArray<readonly [RegExp, HttpReply]>,
		graph: Layer.Layer<HttpClient.HttpClient>,
		fs = NO_CONFIG,
		limit = options.limit,
	) =>
		Effect.runPromise(
			Effect.provide(
				runPick({...options, limit}),
				Layer.mergeAll(
					fakeShell([]).layer,
					routed(fakeHttp([...script, NO_BLOCKERS]).layer, graph),
					fs.layer,
				),
			),
		);

	const runWithTable = (
		script: ReadonlyArray<readonly [RegExp, HttpReply]>,
		github: FakeProjectsOptions,
		fs = NO_CONFIG,
		limit = options.limit,
	) => runWithGraph(script, fakeProjects({repo: "o/r", ...github}).layer, fs, limit);

	/** A Projects API that answers every read with GitHub's secondary rate limit. */
	const RATE_LIMITED = Layer.succeed(HttpClient.HttpClient)(
		HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify({message: "You have exceeded a secondary rate limit."}), {
						status: 403,
						headers: {"content-type": "application/json"},
					}),
				),
			),
		),
	);

	const buckets = (p0: ReadonlyArray<number>, p2: ReadonlyArray<number>) =>
		[
			[bucket("p0"), candidatePage(...p0.map((number) => ({number, labels: [...TRIAGED, "p0"]})))],
			[bucket("p1"), EMPTY],
			[bucket("p2"), candidatePage(...p2.map((number) => ({number, labels: [...TRIAGED, "p2"]})))],
		] as const;

	it("offers a bet ahead of any un-bet issue, whatever its priority", async () => {
		const out = await runWithTable(buckets([500, 400], [300]), {
			projects: [table([{issue: 300, stage: "bet", section: "New bets"}])],
		});
		expect(out.code).toBe(0);
		expect(
			JSON.parse(out.stdout).pool.map((row: {number: number; bet: boolean}) => [
				row.number,
				row.bet,
			]),
		).toEqual([
			[300, true],
			[400, false],
			[500, false],
		]);
		expect(JSON.parse(out.stdout).bets).toEqual({
			state: "read",
			project: "o#7",
			tableDay: THIS_TABLE,
			bets: 1,
			inPool: 1,
		});
		expect(out.stderr.at(-1)).toBe(
			`build pick: bets: 1 bet(s) at the ${THIS_TABLE} table on project o#7, 1 in the pool and first in it.`,
		);
	});

	it("orders several bets by agenda section, not by priority", async () => {
		const out = await runWithTable(buckets([500], [301, 302]), {
			projects: [
				table([
					{issue: 500, stage: "bet", section: "New bets"},
					{issue: 301, stage: "bet", section: "Customers"},
					{issue: 302, stage: "bet", section: "Tails"},
				]),
			],
		});
		expect(pool(out).map((row) => row.number)).toEqual([302, 301, 500]);
	});

	it("does not move a proposed row, or a bet dated an earlier table", async () => {
		const out = await runWithTable(buckets([500], [301, 302]), {
			projects: [
				table([
					{issue: 301, stage: "proposed", section: "Tails"},
					{issue: 302, stage: "bet", section: "Tails", tableDay: LAST_TABLE},
				]),
			],
		});
		expect(pool(out).map((row) => row.number)).toEqual([500, 301, 302]);
		expect(JSON.parse(out.stdout).bets).toMatchObject({bets: 0, inPool: 0});
	});

	it("never offers a bet the admission test refused — bets reorder, they never admit", async () => {
		const out = await runWithTable(
			[
				[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
				[bucket("p1"), EMPTY],
				[
					bucket("p2"),
					candidatePage({number: 300, labels: ["status:triaged", "ready-for:human", "p2"]}),
				],
			],
			{projects: [table([{issue: 300, stage: "bet", section: "Tails"}])]},
		);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(JSON.parse(out.stdout).bets).toMatchObject({bets: 1, inPool: 0});
	});

	it("keeps its own order when the token lacks the project scope and no table is declared", async () => {
		const out = await runWithTable(buckets([500], [300]), {
			projects: [table([{issue: 300, stage: "bet", section: "Tails"}])],
			insufficientScopes: true,
		});
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 300]);
		expect(out.stderr.at(-1)).toContain(PROJECT_SCOPE_FIX);
	});

	it("keeps its own order on a rate-limited table read when no table is declared", async () => {
		const out = await runWithGraph(buckets([500], [300]), RATE_LIMITED);

		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 300]);
		expect(JSON.parse(out.stdout).bets).toEqual({state: "none"});
		expect(out.stderr.join("\n")).toContain("build pick: bets: no table read — the table project:");
	});

	it("refuses on 11 on a rate-limited table read once a table block is declared", async () => {
		const out = await runWithGraph(
			buckets([500], [300]),
			RATE_LIMITED,
			fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table: {stuckDays: 4}})}}),
		);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("keeps its own order on a token without the project scope, even with a table block declared", async () => {
		const out = await runWithTable(
			buckets([500], [300]),
			{projects: [table([{issue: 300, stage: "bet", section: "Tails"}])], insufficientScopes: true},
			fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table: {stuckDays: 4}})}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 300]);
		expect(JSON.parse(out.stdout).bets).toEqual({state: "none"});
		const scopeLines = out.stderr.filter((line) => line.includes(PROJECT_SCOPE_FIX));
		expect(scopeLines).toHaveLength(1);
		expect(scopeLines[0]).toContain("lacks the `project` scope");
		expect(scopeLines[0]).toContain(
			"a missing `project` scope skips the table rather than refusing",
		);
	});

	it("reads the project `table.project.number` names, not the titled one", async () => {
		const out = await runWithTable(
			buckets([500], [300]),
			{
				projects: [
					table([{issue: 500, stage: "bet", section: "Tails"}]),
					table([{issue: 300, stage: "bet", section: "Tails"}], {
						id: "PVT_12",
						number: 12,
						title: "our bets",
						linked: false,
					}),
				],
			},
			fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table: {project: {number: 12}}})}}),
		);
		expect(pool(out).map((row) => row.number)).toEqual([300, 500]);
		expect(JSON.parse(out.stdout).bets).toMatchObject({project: "o#12"});
	});

	/**
	 * A full read, then a slice, is what the pool printed before the early stop. The walk
	 * has to print the same bytes: the full pool at a --limit nothing fills, and its every prefix at
	 * each smaller one.
	 */
	describe("the early stop prints the pool a full read would", () => {
		const BOARD: ReadonlyArray<readonly [RegExp, HttpReply]> = [
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
			[
				bucket("p1"),
				candidatePage(
					{number: 400, labels: [...TRIAGED, "p1"], milestone: 44},
					{number: 401, labels: [...TRIAGED, "p1"], milestone: 39},
					{number: 402, labels: [...TRIAGED, "p1"], milestone: 39},
				),
			],
			[
				bucket("p2"),
				candidatePage(
					{number: 300, labels: [...TRIAGED, "p2"]},
					{number: 301, labels: [...TRIAGED, "p2"]},
				),
			],
			[/^GET \S+\/repos\/o\/r\/issues\/402\/dependencies\/blocked_by/, blockedBy(210)],
			[/^GET \S+\/repos\/o\/r\/issues\/210$/, issue({number: 210, state: "open"})],
			[/^GET \S+\/repos\/o\/r\/issues\/402\/parent$/, NOT_FOUND],
		];
		const PROJECTS = {
			projects: [table([{issue: 300, stage: "bet" as const, section: "Tails" as const}])],
		};
		const FULL = [300, 500, 401, 400, 301];

		it("prints the full-read pool, a bet p2 ahead of the p1s, when --limit never fills", async () => {
			const out = await runWithTable(BOARD, PROJECTS);
			expect(pool(out).map((row) => row.number)).toEqual(FULL);
			expect(JSON.parse(out.stdout).unread).toBe(0);
			expect(excluded(out)).toEqual({blocked: 1});
		});

		it.each(
			FULL.map((_, index) => index + 1),
		)("prints the full-read pool's first %i at that --limit", async (limit) => {
			const out = await runWithTable(BOARD, PROJECTS, NO_CONFIG, limit);
			expect(pool(out).map((row) => row.number)).toEqual(FULL.slice(0, limit));
		});
	});

	it("counts in inPool only the bets whose graph was read and survived", async () => {
		const out = await runWithTable(
			buckets([500], [300, 301]),
			{
				projects: [
					table([
						{issue: 300, stage: "bet", section: "Tails"},
						{issue: 301, stage: "bet", section: "Tails"},
					]),
				],
			},
			NO_CONFIG,
			1,
		);
		expect(pool(out).map((row) => row.number)).toEqual([300]);
		expect(JSON.parse(out.stdout).unread).toBe(2);
		expect(JSON.parse(out.stdout).bets).toMatchObject({bets: 2, inPool: 1});
		expect(out.stderr.at(-1)).toBe(
			`build pick: bets: 2 bet(s) at the ${THIS_TABLE} table on project o#7, 1 in the pool and first in it.`,
		);
	});
});
