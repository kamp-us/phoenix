import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {DIRTY_TREE, NO_COMMIT, OFF_VOCABULARY, ZERO_SCOPE} from "./codes.ts";
import {
	ANCESTOR,
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
	STATUS,
	WRITE,
} from "./fixtures.test-support.ts";
import {runLanded} from "./landed-verb.ts";

const DIFF_TREE = /^git diff-tree --no-commit-id --name-only -r/;
const PARENT = /^git rev-parse --verify --quiet [0-9a-f]+\^1$/;

const DISPATCHED = {
	files: {
		[LEDGER]: ledgerOf({event: "run-opened"}, {event: "slice-dispatched", slice: "C1", sha: BASE}),
		[PLAN]: planFile(),
	},
};

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
	[BRANCH, ON_LANE],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[HEAD, okOut(`${LANDED}\n`)],
	[ANCESTOR, okOut("")],
	[STATUS, okOut("")],
	[DIFF_TREE, okOut("src/totals.ts\nsrc/cart.ts\nsrc/invoice.ts\n")],
	[PARENT, okOut(`${BASE}\n`)],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = WORLD,
	files: FakeFsOptions = DISPATCHED,
) =>
	Effect.runPromise(
		Effect.provide(
			runLanded({number: EPIC, slice: "C1", env: ENV}),
			Layer.merge(fakeShell(script).layer, fakeFs(files).layer),
		),
	);

describe("runLanded", () => {
	it("proves the landing from the graph and answers with the commit the verdict will bind", async () => {
		const outcome = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "landed",
			slice: "C1",
			commit: LANDED,
			parent: BASE,
			files: 3,
		});
	});

	it("refuses an unchanged HEAD on 22 — a dead dispatch is a FACT, not a failed slice", async () => {
		const outcome = await run([[HEAD, okOut(`${BASE}\n`)], ...WORLD]);
		expect(outcome.code).toBe(NO_COMMIT);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toBe(
			`epic landed: HEAD is unchanged since slice "C1" opened (${BASE.slice(0, 8)}) — no commit landed; the dispatch is dead, not the slice failed.`,
		);
	});

	it("refuses a rewritten history on 10 — the old tip is not an ancestor, so a human decides", async () => {
		const outcome = await run([[ANCESTOR, errOut("not an ancestor")], ...WORLD]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("history was rewritten under this run");
	});

	it("refuses a dirty tree beside the new commit on 13 — an unfinished landing is not a landing", async () => {
		const outcome = await run([[STATUS, okOut(" M src/totals.ts\n")], ...WORLD]);
		expect(outcome.code).toBe(DIRTY_TREE);
	});

	it("refuses an empty commit on 7 — it lands nothing", async () => {
		const outcome = await run([[DIFF_TREE, okOut("")], ...WORLD]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toBe(
			"epic landed: the new commit changes zero files — an empty commit lands nothing.",
		);
	});

	it("refuses a slice with no dispatch on record — there is no opening SHA to prove against", async () => {
		const outcome = await run(WORLD, {
			files: {[LEDGER]: ledgerOf({event: "run-opened"}), [PLAN]: planFile()},
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("no slice-dispatched on record");
	});
});
