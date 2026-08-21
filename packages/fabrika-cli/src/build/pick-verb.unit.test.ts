import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, linkNext, type Scripted} from "../fakes.test-support.ts";
import {ROADMAP_FILE} from "../triage/roadmap.ts";
import {FAILED} from "../verb.ts";
import {BAD_SECTIONS, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	blockedBy,
	CRITERIA_BODY,
	campaignsTable,
	candidatePage,
	GATEWAY,
	GH_TOKEN_ENV,
	issue,
	NO_BLOCKERS,
	served,
} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";

const bucket = (priority: string) =>
	new RegExp(
		`^GET https://api\\.github\\.com/repos/o/r/issues\\?state=open&labels=status%3Atriaged%2C${priority}`,
	);

const EMPTY = served([]);
const TRIAGED = ["status:triaged", "ready-for:agent", "type:bug"];

/** A report-shaped body — prose only, no contract anywhere. kamp-us/demlik#4's shape (#6025). */
const REPORT_BODY = "## Summary\n\nsomething is off.\n\n## Pointers\n\n- a file\n";

const options = {
	repo: null,
	limit: 20,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
};

/** No `ROADMAP.md` at all: a well-formed "nothing active", so the scope axis admits everything. */
const NO_CAMPAIGNS = fakeFs({files: {}});

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fs = NO_CAMPAIGNS,
) =>
	Effect.runPromise(
		Effect.provide(
			runPick({...options, ...overrides}),
			Layer.merge(fakeSeams([...script, NO_BLOCKERS]).layer, fs.layer),
		),
	);

const pool = (out: {stdout: string}) =>
	JSON.parse(out.stdout).pool as ReadonlyArray<{number: number}>;

/** The reason histogram `excluded` collapses to (ADR 0308) — counts, never rows. */
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
	 * criteria` finding it after a branch, a build, a push, a PR and a CI run (#6025).
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
	 * cannot do if a shortened pool is attributed to an axis that did not refuse it (#6025).
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
	 * The exemplar collapse of ADR 0308: `excluded` is evidence, so many rows print as counts, while
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

	it("names a standing lane as the home when there is no milestone", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidatePage({number: 500, labels: [...TRIAGED, "p0", "axis:pipeline-hardening"]}),
			],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(JSON.parse(out.stdout).pool[0].home).toBe("axis:pipeline-hardening");
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
			scanned: {p0: 0, p1: 0, p2: 1},
			campaigns: {state: "none"},
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
		]);
		await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(seams.layer, NO_CAMPAIGNS.layer)),
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

	it("excludes an out-of-scope issue with its reason, and keeps the in-scope one", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidatePage(
						{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
						{number: 400, labels: [...TRIAGED, "p0"], milestone: 39},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual({"out-of-scope": 1});
		expect(JSON.parse(out.stdout).campaigns).toEqual({state: "active", milestones: ["44"]});
	});

	it("admits every milestone of a declared SET, and reports the whole set (#6005)", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidatePage(
						{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
						{number: 400, labels: [...TRIAGED, "p0"], milestone: 39},
						{number: 300, labels: [...TRIAGED, "p0"], milestone: 46},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable([44, 46])}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 300]);
		expect(excluded(out)).toEqual({"out-of-scope": 1});
		expect(JSON.parse(out.stdout).campaigns).toEqual({state: "active", milestones: ["44", "46"]});
	});

	it("admits a standing-lane issue under an active campaign — a lane is milestone-less by design", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidatePage({number: 500, labels: [...TRIAGED, "p0", "wayfinder:backlog"]}),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}}),
		);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual({});
	});

	it("refuses an unreadable campaigns table on 11 — never an unfiltered pool", async () => {
		const out = await run(
			[[bucket("p0"), EMPTY]],
			{},
			fakeFs({files: {[ROADMAP_FILE]: null}, unprobeable: [ROADMAP_FILE]}),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the pool is UNKNOWN, never unfiltered");
	});

	it("refuses a malformed campaigns table on 4 — malformed is never read as 'nothing active'", async () => {
		const out = await run(
			[[bucket("p0"), EMPTY]],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44).replace("| active |", "| activ |")}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never read as "nothing is active"');
	});

	it("says on stderr which declaration it judged against", async () => {
		const out = await run(
			[
				[bucket("p0"), EMPTY],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[ROADMAP_FILE]: campaignsTable(44)}}),
		);
		expect(out.stderr.at(-1)).toBe("build pick: campaigns: 1 active — Campaign 44 (#44).");
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
 * The exclusion ADR 0301 gives the pool. The `status:blocked` label it replaces was dropped by
 * accident — the two-`status:`-label hygiene test excluded those issues with no reason printed, and
 * with the label retired that accident stops firing at all.
 */
describe("runPick — the blocked_by graph", () => {
	const edges = (n: number) =>
		new RegExp(`^GET \\S+/repos/o/r/issues/${n}/dependencies/blocked_by`);
	const blocker = (n: number) => new RegExp(`^GET \\S+/repos/o/r/issues/${n}$`);

	it("excludes a candidate with an open blocker, with `blocked` as its named reason", async () => {
		const out = await run([
			[bucket("p0"), candidatePage({number: 500, labels: [...TRIAGED, "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
			[edges(500), blockedBy(210)],
			[blocker(210), issue({number: 210, state: "open"})],
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
		]);
		const out = await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(shell.layer, NO_CAMPAIGNS.layer)),
		);
		expect(out.code).toBe(0);
		expect(shell.requests.some((line) => /dependencies\/blocked_by/.test(line))).toBe(false);
	});
});
