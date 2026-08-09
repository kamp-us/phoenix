import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {candidates} from "./fixtures.test-support.ts";
import {runPick} from "./pick-verb.ts";

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

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runPick({...options, ...overrides}), fakeShell(script).layer));

const pool = (out: {stdout: string}) =>
	JSON.parse(out.stdout).pool as ReadonlyArray<{number: number}>;

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
		expect(JSON.parse(out.stdout)).toEqual({pool: [], scanned: {p0: 0, p1: 0, p2: 1}});
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
		await Effect.runPromise(Effect.provide(runPick(options), shell.layer));
		expect(shell.calls.filter((line) => line.includes("--paginate"))).toHaveLength(3);
	});

	it("refuses a non-positive --limit as a plain usage error", async () => {
		const out = await run([], {limit: 0});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe('build pick: --limit "0" is not a positive integer.');
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
