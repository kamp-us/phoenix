import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {BAD_SECTIONS, PRECONDITION_UNKNOWN} from "./codes.ts";
import {candidates, focusTable} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";
import {DEFAULT_ROADMAP} from "./scope-admission.ts";

const bucket = (priority: string) =>
	new RegExp(
		`^gh api --paginate repos/o/r/issues\\?state=open&labels=status%3Atriaged%2C${priority}`,
	);

const EMPTY = okOut("[]");
const TRIAGED = ["status:triaged", "ready-for:agent", "type:bug"];

const options = {
	repo: null,
	limit: 20,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

/** No `ROADMAP.md` at all: a well-formed "no focus declared", so the scope axis admits everything. */
const NO_FOCUS = fakeFs({files: {}});

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	fs = NO_FOCUS,
) =>
	Effect.runPromise(
		Effect.provide(
			runPick({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	);

const pool = (out: {stdout: string}) =>
	JSON.parse(out.stdout).pool as ReadonlyArray<{number: number}>;

const excluded = (out: {stdout: string}) =>
	JSON.parse(out.stdout).excluded as ReadonlyArray<{
		number: number;
		home: string | null;
		reason: string;
	}>;

describe("runPick", () => {
	it("ranks p0 before p1 before p2, and milestone order inside a bucket", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidates(
					{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
					{number: 400, labels: [...TRIAGED, "p0"], milestone: null},
				),
			],
			[bucket("p1"), candidates({number: 300, labels: [...TRIAGED, "p1"]})],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500, 400, 300]);
	});

	it("excludes an issue with NO ready-for: label — absence is an unknown audience (#4780)", async () => {
		const out = await run([
			[bucket("p0"), candidates({number: 500, labels: ["status:triaged", "type:bug", "p0"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out)).toEqual([]);
		expect(excluded(out)).toEqual([{number: 500, home: null, reason: "audience-not-agent"}]);
	});

	it("excludes an assigned issue — assignment keeps a human's document out (#4764)", async () => {
		const out = await run([
			[bucket("p0"), candidates({number: 500, labels: [...TRIAGED, "p0"], assignees: ["usirin"]})],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(pool(out)).toEqual([]);
	});

	it("excludes type:decision and type:epic, and pull requests", async () => {
		const out = await run([
			[
				bucket("p0"),
				candidates(
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
				candidates({number: 500, labels: [...TRIAGED, "p0", "axis:pipeline-hardening"]}),
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
			[bucket("p2"), candidates({number: 9, labels: ["status:triaged", "p2"]})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			pool: [],
			excluded: [{number: 9, home: null, reason: "audience-not-agent"}],
			scanned: {p0: 0, p1: 0, p2: 1},
			focus: {state: "none"},
		});
	});

	it("refuses a failed bucket read on 11 — a 5xx on p0 never reads as 'no p0s'", async () => {
		const out = await run([
			[bucket("p0"), errOut("gh: Bad gateway (HTTP 502)")],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build pick: cannot read the p0 bucket: gh: Bad gateway (HTTP 502) — the pool is UNKNOWN, never partial.",
		);
	});

	it("paginates every bucket", async () => {
		const shell = fakeShell([
			[bucket("p0"), EMPTY],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		await Effect.runPromise(
			Effect.provide(runPick(options), Layer.merge(shell.layer, NO_FOCUS.layer)),
		);
		expect(shell.calls.filter((line) => line.includes("--paginate"))).toHaveLength(3);
	});

	it("refuses a non-positive --limit as a plain usage error", async () => {
		const out = await run([], {limit: 0});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe('build pick: --limit "0" is not a positive integer.');
	});

	it("refuses a bucket whose paginated output stops mid-page on 11 — a partial board never reads as the whole board", async () => {
		const whole = candidates(
			{number: 1, labels: [...TRIAGED, "p0"]},
			{number: 2, labels: [...TRIAGED, "p0"]},
		).stdout;
		const out = await run([
			[bucket("p0"), okOut(whole.slice(0, whole.length - 30))],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("does not end on a page boundary");
		expect(out.stderr.at(-1)).toContain("the pool is UNKNOWN, never partial");
	});

	it("refuses a bucket whose SECOND page is cut short — the complete first page is not the answer", async () => {
		const first = candidates({number: 1, labels: [...TRIAGED, "p0"]}).stdout;
		const second = candidates({number: 2, labels: [...TRIAGED, "p0"]}).stdout;
		const out = await run([
			[bucket("p0"), okOut(first + second.slice(0, 20))],
			[bucket("p1"), EMPTY],
			[bucket("p2"), EMPTY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("excludes an out-of-focus issue with its reason, and keeps the in-focus one", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidates(
						{number: 500, labels: [...TRIAGED, "p0"], milestone: 44},
						{number: 400, labels: [...TRIAGED, "p0"], milestone: 39},
					),
				],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}}),
		);
		expect(out.code).toBe(0);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual([{number: 400, home: "39", reason: "out-of-focus"}]);
		expect(JSON.parse(out.stdout).focus).toEqual({state: "declared", milestone: "44"});
	});

	it("admits a standing-lane issue under a declared focus — a lane is milestone-less by design", async () => {
		const out = await run(
			[
				[bucket("p0"), candidates({number: 500, labels: [...TRIAGED, "p0", "wayfinder:backlog"]})],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}}),
		);
		expect(pool(out).map((row) => row.number)).toEqual([500]);
		expect(excluded(out)).toEqual([]);
	});

	it("refuses an unreadable focus declaration on 11 — never an unfiltered pool", async () => {
		const out = await run(
			[[bucket("p0"), EMPTY]],
			{},
			fakeFs({files: {[DEFAULT_ROADMAP]: null}, unprobeable: [DEFAULT_ROADMAP]}),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the pool is UNKNOWN, never unfiltered");
	});

	it("refuses a malformed focus declaration on 4 — malformed is never read as 'no focus'", async () => {
		const out = await run(
			[[bucket("p0"), EMPTY]],
			{},
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44).replace("#44", "forty-four")}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never read as "no focus"');
	});

	it("says on stderr which declaration it judged against", async () => {
		const out = await run(
			[
				[bucket("p0"), EMPTY],
				[bucket("p1"), EMPTY],
				[bucket("p2"), EMPTY],
			],
			{},
			fakeFs({files: {[DEFAULT_ROADMAP]: focusTable(44)}}),
		);
		expect(out.stderr.at(-1)).toBe("build pick: focus: milestone #44, declared 2026-08-09.");
	});

	it("caps the pool at --limit after ranking", async () => {
		const out = await run(
			[
				[
					bucket("p0"),
					candidates(
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
