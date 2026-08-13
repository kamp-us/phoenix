import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BREAKER_TRIPPED, COMMIT_NOT_IN_GRAPH, EMPTY_STDIN, OFF_VOCABULARY} from "./codes.ts";
import {
	BASE,
	BRANCH,
	COMMENTS,
	DIR,
	ENV,
	EPIC,
	GIT_DIRS,
	LANDED,
	LEDGER,
	ledgerOf,
	MINE,
	ON_LANE,
	PERM,
	PLAN,
	planFile,
	REV_PARSE,
	verdictMarkerFor,
	WRITE,
} from "./fixtures.test-support.ts";
import {parseLedger} from "./ledger.ts";
import {runVerdict} from "./verdict-verb.ts";

const RESOLVE = /^git rev-parse --verify --quiet [0-9a-f]+\^\{commit\}$/;

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, ON_LANE],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[RESOLVE, okOut(`${LANDED}\n`)],
];

const LANDED_RUN = {
	files: {
		[LEDGER]: ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "slice-landed", slice: "C1", sha: LANDED},
		),
		[PLAN]: planFile(),
	},
};

const BODY =
	"the parser drops the final row when the input lacks a trailing newline\n- criterion 2 unmet\n";

const run = (
	options: Partial<Parameters<typeof runVerdict>[0]> = {},
	files: FakeFsOptions = LANDED_RUN,
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = WORLD,
) => {
	const fs = fakeFs(files);
	return Effect.runPromise(
		Effect.provide(
			runVerdict({
				number: EPIC,
				slice: "C1",
				commit: "8c1f2a9d",
				polarity: "FAIL",
				env: ENV,
				at: "2026-08-09T00:00:00Z",
				stdin: Effect.succeed({_tag: "Text" as const, text: BODY}),
				...options,
			}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

describe("runVerdict", () => {
	it("records the verdict against the FULL SHA, with the body's first line as the marker clause", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "recorded",
			slice: "C1",
			polarity: "FAIL",
			commit: LANDED,
			seq: 4,
		});
		const read = parseLedger(written.get(LEDGER) ?? "");
		expect(read._tag).toBe("Ledger");
		if (read._tag !== "Ledger") return;
		expect(read.lines.at(-1)?.detail).toBe(
			verdictMarkerFor(
				"C1",
				"FAIL",
				LANDED,
				"the parser drops the final row when the input lacks a trailing newline",
			),
		);
	});

	it("stores the body beside the event, keyed by the commit it binds", async () => {
		const {written} = await run();
		expect(written.get(`${DIR}/verdicts/C1-${LANDED}.md`)).toBe(BODY);
	});

	it("refuses an empty body on 3 — an empty verdict grades nothing", async () => {
		const {outcome} = await run(
			{stdin: Effect.succeed({_tag: "Text" as const, text: "   \n"})},
			LANDED_RUN,
			[],
		);
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses a third polarity token on 10", async () => {
		const {outcome} = await run({polarity: "APPROVED"}, LANDED_RUN, []);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'epic verdict: --polarity must be PASS or FAIL — got "APPROVED".',
		);
	});

	it("refuses a commit outside the local graph on 24", async () => {
		const {outcome} = await run({}, LANDED_RUN, [[RESOLVE, errOut("")], ...WORLD]);
		expect(outcome.code).toBe(COMMIT_NOT_IN_GRAPH);
	});

	it("refuses a commit that is not the slice's LANDED commit on 10 — a verdict binds what landed", async () => {
		const other = "b".repeat(40);
		const {outcome, written} = await run({}, LANDED_RUN, [
			[RESOLVE, okOut(`${other}\n`)],
			...WORLD,
		]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain('is not slice "C1"\'s landed commit');
		expect(written.size).toBe(0);
	});

	it("refuses to record past a tripped breaker on 23", async () => {
		const fail = {
			event: "verdict-recorded" as const,
			slice: "C1",
			detail: verdictMarkerFor("C1", "FAIL", LANDED, "still wrong"),
		};
		const {outcome} = await run(
			{},
			{
				files: {
					[LEDGER]: ledgerOf(
						{event: "run-opened"},
						{event: "slice-dispatched", slice: "C1", sha: BASE},
						{event: "slice-landed", slice: "C1", sha: LANDED},
						fail,
						fail,
					),
					[PLAN]: planFile(),
				},
			},
		);
		expect(outcome.code).toBe(BREAKER_TRIPPED);
	});
});
