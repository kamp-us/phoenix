import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	BAD_SECTIONS,
	NOT_A_WORKTREE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNNAMEABLE_STATE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	COMMENTS,
	childJson,
	DIR,
	ENV,
	EPIC,
	EPIC_ISSUE,
	GIT_DIR,
	issueJson,
	LEDGER,
	LINKED,
	ledgerOf,
	MINE,
	PERM,
	PLAN,
	REV_PARSE,
	RUN,
	WRITE,
} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";

const C1 = /^gh api repos\/o\/r\/issues\/4301$/;
const C2 = /^gh api repos\/o\/r\/issues\/4302$/;

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[EPIC_ISSUE, issueJson()],
	[C1, childJson(4301, "extract the totals module")],
	[C2, childJson(4302, "half-cent rounding fix")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = WORLD,
	files: FakeFsOptions = {},
) => {
	const fs = fakeFs(files);
	return Effect.runPromise(
		Effect.provide(
			runOpen({number: EPIC, repo: null, env: ENV, at: "2026-08-09T00:00:00Z"}),
			Layer.merge(fakeShell(script).layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

describe("runOpen", () => {
	it("derives the slices, keys the ledger to the claim nonce, and answers opened", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "opened",
			epic: EPIC,
			run: RUN,
			slices: [
				{id: "C1", issue: 4301, title: "extract the totals module", criteria: "found"},
				{id: "C2", issue: 4302, title: "half-cent rounding fix", criteria: "found"},
			],
			order: ["C1", "C2"],
			resumed: false,
		});
		expect(written.has(LEDGER)).toBe(true);
		expect(written.has(PLAN)).toBe(true);
	});

	it("registers the run directory in the tree's git exclude, so it can never enter the PR", async () => {
		const {written} = await run();
		expect(written.get(`${GIT_DIR}/info/exclude`)).toContain(".fabrika-epic/");
	});

	it("re-opens idempotently: a ledger already at this key answers resumed and appends nothing", async () => {
		const existing = ledgerOf({event: "run-opened"});
		const {outcome, written} = await run(WORLD, {files: {[LEDGER]: existing}});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).resumed).toBe(true);
		expect(written.has(LEDGER)).toBe(false);
	});

	it("refuses a ledger holding unnameable state on 21 rather than opening over it", async () => {
		const {outcome} = await run(WORLD, {files: {[LEDGER]: "{not json}\n"}});
		expect(outcome.code).toBe(UNNAMEABLE_STATE);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a body with no parseable planned ledger on 4 — never 'no slices'", async () => {
		const prose = issueJson({body: "We'll figure the slices out as we go.\n"});
		const {outcome, written} = await run([
			[REV_PARSE, LINKED],
			[COMMENTS, MINE],
			[PERM, WRITE],
			[EPIC_ISSUE, prose],
		]);
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("no parseable planned ledger");
		expect(written.size).toBe(0);
	});

	it("refuses an issue that is not a type:epic on 10", async () => {
		const {outcome} = await run([
			[REV_PARSE, LINKED],
			[COMMENTS, MINE],
			[PERM, WRITE],
			[EPIC_ISSUE, issueJson({labels: [{name: "type:feature"}]})],
		]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a proven-absent child on 7 and an unreadable one on 11 — never the same code", async () => {
		// The script resolves on the FIRST matching pattern, so the override leads.
		const absent = await run([[C1, errOut("gh: Not Found (HTTP 404)")], ...WORLD]);
		expect(absent.outcome.code).toBe(ZERO_SCOPE);
		const unreadable = await run([[C1, errOut("gh: Bad gateway (HTTP 502)")], ...WORLD]);
		expect(unreadable.outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses the primary checkout on 12 before it reads anything", async () => {
		const {outcome} = await run([
			[REV_PARSE, okOut(["/repo/.git", "/repo/.git", "/repo"].join("\n"))],
		]);
		expect(outcome.code).toBe(NOT_A_WORKTREE);
	});

	it("writes the run's files under the claim-nonce key, never a session key", async () => {
		const {written} = await run();
		expect(
			[...written.keys()].every((path) => path.startsWith(DIR) || path.includes("info/exclude")),
		).toBe(true);
		expect([...written.keys()].some((path) => path.includes("s-2ee1"))).toBe(false);
	});
});
