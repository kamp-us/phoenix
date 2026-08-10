import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	BREAKER_TRIPPED,
	NO_RUN,
	OFF_VOCABULARY,
	READBACK_MISMATCH,
	UNNAMEABLE_STATE,
	WRONG_LANE,
} from "./codes.ts";
import {
	BASE,
	BRANCH,
	COMMENTS,
	ENV,
	EPIC,
	HEAD,
	LANDED,
	LEDGER,
	LINKED,
	ledgerOf,
	MINE,
	ON_LANE,
	PERM,
	PLAN,
	planFile,
	REV_PARSE,
	RUN,
	verdictMarkerFor,
	WRITE,
} from "./fixtures.test-support.ts";
import {parseLedger} from "./ledger.ts";
import {runRecord} from "./record-verb.ts";

const LANE: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
	[BRANCH, ON_LANE],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[HEAD, okOut(`${LANDED}\n`)],
];

const OPENED = {files: {[LEDGER]: ledgerOf({event: "run-opened"}), [PLAN]: planFile()}};

const run = (
	options: Partial<Parameters<typeof runRecord>[0]> = {},
	files: FakeFsOptions = OPENED,
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = LANE,
) => {
	const fs = fakeFs(files);
	return Effect.runPromise(
		Effect.provide(
			runRecord({
				number: EPIC,
				event: "slice-dispatched",
				slice: "C1",
				detail: null,
				env: ENV,
				at: "2026-08-09T00:00:00Z",
				...options,
			}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

describe("runRecord", () => {
	it("appends the event and answers with its seq", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "recorded",
			seq: 2,
			event: "slice-dispatched",
			slice: "C1",
		});
		expect(
			written
				.get(LEDGER)
				?.split("\n")
				.filter((l) => l !== ""),
		).toHaveLength(2);
	});

	it("SELF-CAPTURES HEAD into the appended line, and keeps it out of the answer", async () => {
		const {outcome, written} = await run();
		expect(outcome.stdout).not.toContain(LANDED);
		const read = parseLedger(written.get(LEDGER) ?? "");
		expect(read._tag).toBe("Ledger");
		if (read._tag !== "Ledger") return;
		expect(read.lines.at(-1)?.sha).toBe(LANDED);
	});

	it("refuses verdict-recorded here — only `epic verdict` may bind a SHA", async () => {
		const {outcome, written} = await run({event: "verdict-recorded"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'epic record: verdict-recorded is written only by "fabrika epic verdict" — use it.',
		);
		expect(written.size).toBe(0);
	});

	it("refuses an off-enum event on 10, before any tree or claim read", async () => {
		const {outcome} = await run({event: "slice-skipped"}, OPENED, []);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'epic record: --event "slice-skipped" is not in the event vocabulary.',
		);
	});

	it("refuses a slice the run does not carry on 10", async () => {
		const {outcome} = await run({slice: "C9"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(`epic record: slice "C9" is not in run ${RUN}.`);
	});

	it("refuses a landing for a slice that was never dispatched — it contradicts derived state", async () => {
		const {outcome} = await run({event: "slice-landed"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses any further slice event past a tripped breaker, except breaker-tripped itself", async () => {
		const fail = {
			event: "verdict-recorded" as const,
			slice: "C1",
			detail: verdictMarkerFor("C1", "FAIL", LANDED, "still wrong"),
		};
		const tripped = {
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
		};
		const refused = await run({event: "retry-injected"}, tripped);
		expect(refused.outcome.code).toBe(BREAKER_TRIPPED);
		expect(refused.outcome.stderr.at(-1)).toContain("fail breaker is at cap");

		const allowed = await run({event: "breaker-tripped"}, tripped);
		expect(allowed.outcome.code).toBe(0);
	});

	it("refuses a run with no ledger on 20, naming its repair", async () => {
		const {outcome} = await run({}, {files: {}});
		expect(outcome.code).toBe(NO_RUN);
		expect(outcome.stderr.at(-1)).toBe(
			`epic record: no run ledger for #${EPIC} in this lane — run "fabrika epic open ${EPIC}" first.`,
		);
	});

	it("refuses unnameable ledger state on 21", async () => {
		const {outcome} = await run({}, {files: {[LEDGER]: "garbage\n", [PLAN]: planFile()}});
		expect(outcome.code).toBe(UNNAMEABLE_STATE);
	});

	it("refuses a wrong lane branch on 14 — the imported guard, not a second check", async () => {
		const {outcome} = await run({}, OPENED, [
			[REV_PARSE, LINKED],
			[BRANCH, okOut("build/9999-other-lane-deadbeef\n")],
			[COMMENTS, MINE],
			[PERM, WRITE],
		]);
		expect(outcome.code).toBe(WRONG_LANE);
	});

	it("refuses on 9 when the tail does not read back", async () => {
		const {outcome} = await run({}, {...OPENED, unwritable: [LEDGER]});
		expect([READBACK_MISMATCH, 8]).toContain(outcome.code);
	});
});
