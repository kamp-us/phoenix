import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, record} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {binding, HEAD, pull, SHOW_AT, STATUS_AT, statuses} from "./fixtures.test-support.ts";
import {runSweep} from "./sweep-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const DIR = ".decisions";
const SUBJECT_PATH = ".decisions/0240-only-landed-adrs-may-be-cited.md";

/** Twelve members, so the corpus clears the imported rarity floor of ten. */
const names = Array.from({length: 12}, (_, i) => `${String(i + 1).padStart(4, "0")}-a-decision.md`);

const corpusFiles = (): Record<string, string> =>
	Object.fromEntries(
		names.map((name, i) => [
			`${DIR}/${name}`,
			record(
				name.slice(0, 4),
				"accepted",
				i === 0 ? "Verdicts bind a head sha immutably." : "Unrelated.",
			),
		]),
	);

const options = {
	pr: null as number | null,
	record: null as string | null,
	landed: null as string | null,
	sha: null as string | null,
	dir: DIR,
	limit: 8,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	fs = fakeFs({dirs: {[DIR]: names}, files: corpusFiles()}),
) =>
	Effect.runPromise(
		Effect.provide(
			runSweep({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	);

describe("runSweep in --landed mode", () => {
	it("ranks the corpus against a record already in --dir and exits 0", async () => {
		const out = await run([], {landed: "0001"});
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toMatch(/^(shortlist|no-overlap)$/);
	});

	it("carries the not-a-clearance sentence on the no-overlap arm's `reason`", async () => {
		const out = await run([], {landed: "0002", json: true});
		const parsed = JSON.parse(out.stdout);
		if (parsed.outcome === "no-overlap") {
			expect(parsed.reason).toContain("this is not a clearance");
		}
		expect(parsed.subject).toBe("0002");
	});

	it("answers `indeterminate` at exit 0 below the imported rarity floor", async () => {
		const small = ["0001-a.md", "0002-b.md"];
		const out = await run(
			[],
			{landed: "0001"},
			fakeFs({
				dirs: {[DIR]: small},
				files: {
					[`${DIR}/0001-a.md`]: record("0001", "accepted"),
					[`${DIR}/0002-b.md`]: record("0002", "accepted"),
				},
			}),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.trim()).toBe("indeterminate");
	});

	it("refuses a zero-record corpus on 7 rather than answering no-overlap over nothing", async () => {
		const out = await run([], {landed: "0001"}, fakeFs({dirs: {[DIR]: []}}));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"governance sweep: scanned .decisions, 0 decision records — refusing to answer (ADR 0092).",
		);
	});

	it("refuses an UNREADABLE member on 11 — an incomplete corpus is UNKNOWN", async () => {
		const out = await run(
			[],
			{landed: "0001"},
			fakeFs({
				dirs: {[DIR]: names},
				files: corpusFiles(),
				unreadable: [`${DIR}/${names[3]}`],
			}),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain('an incomplete corpus is UNKNOWN, never "no-overlap"');
	});

	it("refuses an unlistable --dir on 11, distinct from an empty one", async () => {
		const out = await run([], {landed: "0001"}, fakeFs({}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a --landed id the corpus does not carry on 11", async () => {
		const out = await run([], {landed: "9999"});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("carries no decision record 9999");
	});
});

describe("runSweep in --record mode", () => {
	const scripted: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 1})],
		...binding(),
		[STATUS_AT(), statuses(["A", SUBJECT_PATH])],
		[
			SHOW_AT(HEAD, SUBJECT_PATH),
			okOut(record("0240", "proposed", "Only landed ADRs may be cited.")),
		],
	];

	it("reads the subject at the BOUND commit and ranks against the corpus", async () => {
		const out = await run(scripted, {pr: 4321, record: "0240"});
		expect(out.code).toBe(0);
		expect(out.stderr[0]).toContain(`bound to ${HEAD}`);
	});

	it("refuses when the bound commit carries no such record on 11", async () => {
		const out = await run(
			[[PULL, pull({changedFiles: 1})], ...binding(), [STATUS_AT(), statuses(["M", "src/a.ts"])]],
			{pr: 4321, record: "0240"},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("carries no decision record 0240");
	});

	it("refuses a short changed-file read on 13", async () => {
		const out = await run(
			[[PULL, pull({changedFiles: 9})], ...binding(), [STATUS_AT(), statuses(["A", SUBJECT_PATH])]],
			{pr: 4321, record: "0240"},
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("refusing to prove 0240 is in this PR from a short read");
	});

	it("refuses an absent PR on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]], {pr: 4321, record: "0240"});
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

describe("runSweep's usage fence", () => {
	it("refuses both a PR and --landed, and neither, on 10", async () => {
		expect((await run([], {pr: 4321, record: "0240", landed: "0240"})).code).toBe(OFF_VOCABULARY);
		expect((await run([], {})).code).toBe(OFF_VOCABULARY);
	});

	it("refuses a non-four-digit id on 10", async () => {
		const out = await run([], {landed: "240"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'governance sweep: --landed "240" is not a four-digit decision id.',
		);
	});

	it("refuses a negative --limit on 10", async () => {
		const out = await run([], {landed: "0001", limit: -1});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("a shortlist cannot be shorter than empty");
	});
});
