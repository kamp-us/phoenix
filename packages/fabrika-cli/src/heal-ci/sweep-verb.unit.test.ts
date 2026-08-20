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
	behind,
	CHECK_RUNS,
	COMMIT_DATE,
	COMPARE,
	checkRuns,
	comments,
	commitDate,
	ENV,
	files,
	HEAD,
	httpError,
	OPEN_PULLS,
	openPulls,
	PROTECTION,
	protection,
	pull,
	RATE_LIMIT,
	RULES,
	RUN_COUNT,
	rateLimit,
	reviews,
	rules,
	runsTotal,
	timeline,
	WORKFLOWS,
	workflows,
} from "./fixtures.test-support.ts";
import {runSweep} from "./sweep-verb.ts";

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
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	served: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runSweep({...options, ...overrides}),
			Layer.mergeAll(fakeShell(script).layer, unconfigured, fakeHttp(served).layer),
		),
	);

/** One classifiable PR's `gh` reads, reachable by any number: they are not keyed on it. */
const classifiable = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[/^gh api repos\/o\/r\/pulls\/\d+$/, pull({updatedAt: PUSHED})],
	[
		/^gh api --paginate repos\/o\/r\/pulls\/\d+\/files/,
		files("apps/web/worker/a.ts", "apps/web/worker/b.ts"),
	],
	[CHECK_RUNS, checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "success"}])],
	[WORKFLOWS, workflows("active")],
	[RUN_COUNT, runsTotal(3)],
	[/^gh api --paginate repos\/o\/r\/issues\/\d+\/comments/, comments()],
	[/^gh api -i repos\/o\/r\/issues\/\d+\/timeline/, timeline()],
	[/^gh api -i repos\/o\/r\/pulls\/\d+\/reviews/, reviews()],
	[COMPARE, behind(0)],
];

/** The same PR's reads over the HTTP client, beneath whichever board read the case scripts. */
const classifiableHttp = (
	board: readonly [RegExp, HttpReply],
): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	board,
	[RATE_LIMIT, rateLimit(4000)],
	[COMMIT_DATE, commitDate(PUSHED)],
	[RULES, rules("ci-required")],
	[PROTECTION, protection()],
];

describe("runSweep reports the whole board or none of it", () => {
	it("prints both counts and one row per stalled PR, oldest strand first", async () => {
		const out = await run(
			classifiable(),
			classifiableHttp([
				OPEN_PULLS,
				openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD}),
			]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			["swept\t2\t2", `pr\t4321\tungated\t60\t${HEAD}`, `pr\t4322\tungated\t60\t${HEAD}`, ""].join(
				"\n",
			),
		);
	});

	it("answers a quiet board rather than refusing it", async () => {
		const out = await run([], [[OPEN_PULLS, openPulls()]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t0\t0\n");
	});

	it("omits a PR inside the grace window", async () => {
		const out = await run(
			classifiable(),
			classifiableHttp([OPEN_PULLS, openPulls({number: 4321, head: HEAD})]),
			{minAgeMinutes: 600},
		);
		expect(out.stdout).toBe("swept\t1\t0\n");
	});

	it("writes nothing at all", async () => {
		const shell = fakeShell(classifiable());
		const http = fakeHttp(classifiableHttp([OPEN_PULLS, openPulls({number: 4321, head: HEAD})]));
		await Effect.runPromise(
			Effect.provide(runSweep(options), Layer.mergeAll(shell.layer, unconfigured, http.layer)),
		);
		expect(shell.calls.some((call) => call.includes("--method POST"))).toBe(false);
		expect(http.calls.every((call) => call.startsWith("GET "))).toBe(true);
	});
});

describe("runSweep refuses a board it could not read whole", () => {
	it("refuses an unexhausted open-PR read on 13", async () => {
		const out = await run(
			[],
			[[OPEN_PULLS, {...openPulls(), headers: linkNext("https://api.github.com/next")}]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable list on 11 — never `none stranded`", async () => {
		const out = await run([], [[OPEN_PULLS, httpError(502, "Bad gateway")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "none stranded"');
	});

	it("refuses a board larger than --limit rather than answering over a subset", async () => {
		const out = await run(
			[],
			[[OPEN_PULLS, openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD})]],
			{limit: 1},
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("exceeds --limit 1");
	});

	it("refuses a sweep with a hole in it rather than dropping the PR", async () => {
		const out = await run(
			[[/^gh api repos\/o\/r\/pulls\/\d+$/, errOut("gh: Bad gateway (HTTP 502)")]],
			[
				[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
				[RATE_LIMIT, rateLimit(4000)],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("refusing a sweep with a hole in it");
	});

	it("refuses a partial board on an exhausted rate limit, emitting nothing", async () => {
		const out = await run(
			[],
			[
				[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
				[RATE_LIMIT, rateLimit(2)],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing a partial board");
	});

	it("counts a PR that vanished between the list read and its classification as scanned", async () => {
		const out = await run(
			[[/^gh api repos\/o\/r\/pulls\/\d+$/, errOut("gh: Not Found (HTTP 404)")]],
			[
				[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
				[RATE_LIMIT, rateLimit(4000)],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t1\t0\n");
		expect(out.stderr.join("\n")).toContain("counted as scanned, not stalled");
	});
});
