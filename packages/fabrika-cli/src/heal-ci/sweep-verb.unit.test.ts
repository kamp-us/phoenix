import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeHttp,
	fakeShell,
	type HttpReply,
	linkNext,
	unconfigured,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	COMMIT_DATE,
	checkRuns,
	comments,
	commitDate,
	ENV,
	files,
	HEAD,
	openPulls,
	PROTECTION,
	protection,
	pull,
	RATE_LIMIT,
	rateLimit,
	reviews,
	rules,
	runsTotal,
	timeline,
	unexhaustedPage,
	workflows,
} from "./fixtures.test-support.ts";
import {runSweep} from "./sweep-verb.ts";

/** The reads that moved to the fetch client. The rest of the per-PR set still shells out to `gh`. */
const OPEN_PULLS = /repos\/o\/r\/pulls\?state=open/;
const CHECK_RUNS = /repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const WORKFLOWS = /repos\/o\/r\/actions\/workflows/;
const RUN_COUNT = /repos\/o\/r\/actions\/runs\?head_sha=[0-9a-f]+&per_page=1$/;
const RULES = /repos\/o\/r\/rules\/branches\/main/;
const TIMELINE = /repos\/o\/r\/issues\/\d+\/timeline/;
const REVIEWS = /repos\/o\/r\/pulls\/\d+\/reviews/;
const COMPARE = /repos\/o\/r\/compare\/main\.\.\.[0-9a-f]+$/;

/**
 * A canned payload, served over HTTP rather than printed by a subprocess.
 *
 * The fixtures stay the one source for every payload shape — only the transport around them changed,
 * so a second literal here is how this test would come to disagree with the rest of the group.
 */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

/**
 * The same, for a fixture written in the `gh api -i` shape: its body, carrying the `Link` proof the
 * fixture declared. A page that declares a `next` is one the caller can never prove complete.
 */
const servedPage = (result: ExecResult): HttpReply => {
	const [head = "", body = ""] = result.stdout.split("\r\n\r\n");
	return {
		status: 200,
		body,
		headers: /rel="next"/.test(head) ? linkNext("https://api.github.com/next?page=2") : undefined,
	};
};

/** The compare read hands back the whole record now, not the `--jq`-projected number. */
const behind = (by: number): HttpReply => ({status: 200, body: JSON.stringify({behind_by: by})});

const NOW = Date.parse("2026-08-08T01:00:00Z");
const PUSHED = "2026-08-08T00:00:00Z";

const options = {
	minAgeMinutes: 30,
	limit: 200,
	includeAttended: false,
	dwellMinutes: 45,
	wedgeDwellMinutes: 20,
	driftCommits: 10,
	repo: null,
	json: false,
	cwd: "/repo",
	env: ENV,
	now: NOW,
};

const run = (
	shell: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runSweep({...options, ...overrides}),
			Layer.mergeAll(fakeShell(shell).layer, fakeHttp(http).layer, unconfigured),
		),
	);

/** The subprocess half of one classifiable PR, reachable by any number: the reads are not keyed on it. */
const shelled = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[RATE_LIMIT, rateLimit(4000)],
	[/^gh api repos\/o\/r\/pulls\/\d+$/, pull({updatedAt: PUSHED})],
	[
		/^gh api --paginate repos\/o\/r\/pulls\/\d+\/files/,
		files("apps/web/worker/a.ts", "apps/web/worker/b.ts"),
	],
	[COMMIT_DATE, commitDate(PUSHED)],
	[PROTECTION, protection()],
	[/^gh api --paginate repos\/o\/r\/issues\/\d+\/comments/, comments()],
];

/** The HTTP half of the same PR. */
const fetched = (): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	[
		CHECK_RUNS,
		served(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "success"}])),
	],
	[WORKFLOWS, served(workflows("active"))],
	[RUN_COUNT, served(runsTotal(3))],
	[RULES, servedPage(rules("ci-required"))],
	[TIMELINE, servedPage(timeline())],
	[REVIEWS, servedPage(reviews())],
	[COMPARE, behind(0)],
];

describe("runSweep reports the whole board or none of it", () => {
	it("prints both counts and one row per stalled PR, oldest strand first", async () => {
		const out = await run(shelled(), [
			[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD}))],
			...fetched(),
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			["swept\t2\t2", `pr\t4321\tungated\t60\t${HEAD}`, `pr\t4322\tungated\t60\t${HEAD}`, ""].join(
				"\n",
			),
		);
	});

	it("answers a quiet board rather than refusing it", async () => {
		const out = await run([], [[OPEN_PULLS, servedPage(openPulls())]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t0\t0\n");
	});

	it("omits a PR inside the grace window", async () => {
		const out = await run(
			shelled(),
			[[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}))], ...fetched()],
			{minAgeMinutes: 600},
		);
		expect(out.stdout).toBe("swept\t1\t0\n");
	});

	it("writes nothing at all", async () => {
		const shell = fakeShell(shelled());
		const http = fakeHttp([
			[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}))],
			...fetched(),
		]);
		await Effect.runPromise(
			Effect.provide(runSweep(options), Layer.mergeAll(shell.layer, http.layer, unconfigured)),
		);
		expect(shell.calls.some((call) => call.includes("--method POST"))).toBe(false);
		expect(http.calls.every((call) => call.startsWith("GET "))).toBe(true);
	});
});

describe("runSweep refuses a board it could not read whole", () => {
	it("refuses an unexhausted open-PR read on 13", async () => {
		const out = await run([], [[OPEN_PULLS, servedPage(unexhaustedPage())]]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable list on 11 — never `none stranded`", async () => {
		const out = await run([], [[OPEN_PULLS, {status: 502, body: '{"message":"Bad gateway"}'}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "none stranded"');
	});

	it("refuses a board larger than --limit rather than answering over a subset", async () => {
		const out = await run(
			[],
			[[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD}))]],
			{limit: 1},
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("exceeds --limit 1");
	});

	it("refuses a sweep with a hole in it rather than dropping the PR", async () => {
		const out = await run(
			[
				[RATE_LIMIT, rateLimit(4000)],
				[/^gh api repos\/o\/r\/pulls\/\d+$/, errOut("gh: Bad gateway (HTTP 502)")],
			],
			[[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}))]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("refusing a sweep with a hole in it");
	});

	it("refuses a partial board on an exhausted rate limit, emitting nothing", async () => {
		const out = await run(
			[[RATE_LIMIT, rateLimit(2)]],
			[[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}))]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing a partial board");
	});

	it("counts a PR that vanished between the list read and its classification as scanned", async () => {
		const out = await run(
			[
				[RATE_LIMIT, rateLimit(4000)],
				[/^gh api repos\/o\/r\/pulls\/\d+$/, errOut("gh: Not Found (HTTP 404)")],
			],
			[[OPEN_PULLS, servedPage(openPulls({number: 4321, head: HEAD}))]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t1\t0\n");
		expect(out.stderr.join("\n")).toContain("counted as scanned, not stalled");
	});
});
