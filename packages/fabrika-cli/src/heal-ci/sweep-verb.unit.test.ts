import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	fakeSeams,
	type HttpReply,
	linkNext,
	type Scripted,
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
	httpError,
	OPEN_PULLS,
	openPulls,
	PROTECTION,
	protection,
	pull,
	RATE_LIMIT,
	RULES,
	rateLimit,
	rules,
	runsTotal,
	workflows,
} from "./fixtures.test-support.ts";
import {runSweep} from "./sweep-verb.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/\d+$/;
const FILES = /^GET .*\/repos\/o\/r\/pulls\/\d+\/files\?/;
const CHECK_RUNS = /^GET .*\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const WORKFLOWS = /^GET .*\/repos\/o\/r\/actions\/workflows\?/;
const RUN_COUNT = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=[0-9a-f]+&per_page=1$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/\d+\/comments\?/;
const TIMELINE = /^GET .*\/repos\/o\/r\/issues\/\d+\/timeline\?/;
const REVIEWS = /^GET .*\/repos\/o\/r\/pulls\/\d+\/reviews\?/;
const COMPARE = /^GET .*\/repos\/o\/r\/compare\/main\.\.\.[0-9a-f]+$/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/** An empty bare-array page — no `Link`, so the walk is proven exhausted. */
const emptyPage: HttpReply = {status: 200, body: "[]"};

/** `compare` answers a record; `behind_by` is the field, not the `--jq` era's bare number. */
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

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runSweep({...options, ...overrides}),
			Layer.mergeAll(fakeSeams(script).layer, unconfigured),
		),
	);

/** One classifiable PR's reads, reachable by any number: they are not keyed on it. */
const classifiable = (board: Scripted): ReadonlyArray<Scripted> => [
	board,
	[RATE_LIMIT, rateLimit(4000)],
	[PULL, reply(pull({updatedAt: PUSHED}))],
	[FILES, reply(files("apps/web/worker/a.ts", "apps/web/worker/b.ts"))],
	[
		CHECK_RUNS,
		reply(checkRuns(1, [{name: "ci-required", status: "completed", conclusion: "success"}])),
	],
	[WORKFLOWS, reply(workflows("active"))],
	[RUN_COUNT, reply(runsTotal(3))],
	[COMMENTS, reply(comments())],
	[TIMELINE, emptyPage],
	[REVIEWS, emptyPage],
	[COMPARE, behind(0)],
	[COMMIT_DATE, commitDate(PUSHED)],
	[RULES, rules("ci-required")],
	[PROTECTION, protection()],
];

describe("runSweep reports the whole board or none of it", () => {
	it("prints both counts and one row per stalled PR, oldest strand first", async () => {
		const out = await run(
			classifiable([OPEN_PULLS, openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD})]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"swept\t2\t2",
				`pr\t4321\tungated\t60\t${HEAD}\treview`,
				`pr\t4322\tungated\t60\t${HEAD}\treview`,
				"",
			].join("\n"),
		);
	});

	// The scheduled workflow relays this column into the note's first line, so an absent or
	// hardcoded lane is a note telling every reader the detector found nothing to do (#7209).
	it("carries the class's arrow as the row's sixth column, never a fixed word", async () => {
		const out = await run(classifiable([OPEN_PULLS, openPulls({number: 4321, head: HEAD})]), {
			json: true,
		});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).prs).toEqual([
			{number: 4321, token: "ungated", ageMinutes: 60, head: HEAD, lane: "review"},
		]);
	});

	it("answers a quiet board rather than refusing it", async () => {
		const out = await run([[OPEN_PULLS, openPulls()]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t0\t0\n");
	});

	it("omits a PR inside the grace window", async () => {
		const out = await run(classifiable([OPEN_PULLS, openPulls({number: 4321, head: HEAD})]), {
			minAgeMinutes: 600,
		});
		expect(out.stdout).toBe("swept\t1\t0\n");
	});

	it("writes nothing at all", async () => {
		const seams = fakeSeams(classifiable([OPEN_PULLS, openPulls({number: 4321, head: HEAD})]));
		await Effect.runPromise(
			Effect.provide(runSweep(options), Layer.mergeAll(seams.layer, unconfigured)),
		);
		expect(seams.requests.every((request) => request.startsWith("GET "))).toBe(true);
	});
});

describe("runSweep refuses a board it could not read whole", () => {
	it("refuses an unexhausted open-PR read on 13", async () => {
		const out = await run([
			[OPEN_PULLS, {...openPulls(), headers: linkNext("https://api.github.com/next")}],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable list on 11 — never `none stranded`", async () => {
		const out = await run([[OPEN_PULLS, httpError(502, "Bad gateway")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "none stranded"');
	});

	it("refuses a board larger than --limit rather than answering over a subset", async () => {
		const out = await run(
			[[OPEN_PULLS, openPulls({number: 4321, head: HEAD}, {number: 4322, head: HEAD})]],
			{limit: 1},
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("exceeds --limit 1");
	});

	it("refuses a sweep with a hole in it rather than dropping the PR", async () => {
		const out = await run([
			[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
			[RATE_LIMIT, rateLimit(4000)],
			[PULL, httpError(502, "Bad gateway")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("refusing a sweep with a hole in it");
	});

	it("refuses a partial board on an exhausted rate limit, emitting nothing", async () => {
		const out = await run([
			[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
			[RATE_LIMIT, rateLimit(2)],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing a partial board");
	});

	it("counts a PR that vanished between the list read and its classification as scanned", async () => {
		const out = await run([
			[OPEN_PULLS, openPulls({number: 4321, head: HEAD})],
			[RATE_LIMIT, rateLimit(4000)],
			[PULL, httpError(404, "Not Found")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("swept\t1\t0\n");
		expect(out.stderr.join("\n")).toContain("counted as scanned, not stalled");
	});
});
