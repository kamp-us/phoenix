import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BAD_SECTIONS, BLOCKED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runEligible} from "./eligible-verb.ts";
import {issue} from "./fixtures.test-support.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const PARENT = /^gh api repos\/o\/r\/issues\/4312\/parent/;
const LEDGER = /^gh api repos\/o\/r\/issues\/4300$/;
const PRED = (n: number) => new RegExp(`^gh api repos/o/r/issues/${n}$`);

const NOT_FOUND = errOut("gh: Not Found (HTTP 404)");
const GATEWAY = errOut("gh: Bad gateway (HTTP 502)");

const ledger = (body: string) =>
	issue({number: 4300, body: `# Epic\n\n## Dependencies\n\n${body}\n`});

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(runEligible(options), fakeShell(script).layer));

describe("runEligible", () => {
	it("answers eligible for a standalone issue, with parent null", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, NOT_FOUND],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "eligible", number: 4312, parent: null});
	});

	it("answers eligible when every named predecessor is closed", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210\n- phase 2: #4312")],
			[PRED(210), issue({number: 210, state: "closed"})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).parent).toBe(4300);
		expect(out.stderr.at(-1)).toContain("scanned 1 dependency edge");
	});

	it("refuses on 16 and NAMES the open edge", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210\n- phase 2: #4312\n- #4312 requires: #210")],
			[PRED(210), issue({number: 210, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build eligible: blocked by 1 open dependency edge: requires: #210.",
		);
	});

	it("names EVERY open edge, not only the first", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210, #211\n- phase 2: #4312")],
			[PRED(210), issue({number: 210, state: "open"})],
			[PRED(211), issue({number: 211, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe(
			"build eligible: blocked by 2 open dependency edges: phase #210, phase #211.",
		);
	});

	it("treats a ledger-local ref as an open edge — unfiled work is open work", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: C1\n- phase 2: #4312")],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe(
			"build eligible: blocked by 1 open dependency edge: phase C1 (unfiled, so open).",
		);
	});

	it("refuses an unparseable Dependencies block on 4 — never reads it as 'no edges'", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- #4312 comes after the API work")],
		]);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.at(-1)).toBe(
			'build eligible: parent #4300 has no parseable "## Dependencies" block — eligibility cannot be derived, and "no edges found" is never read as "eligible".',
		);
	});

	it("refuses a proven-absent issue on 7", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("build eligible: issue #4312 is proven absent or closed.");
	});

	/**
	 * One case per unreadable input the derivation has (#4920). Each pins `11`: the whole point is that
	 * no read failure anywhere on the path can resolve to "eligible", and a suite that leaves one path
	 * unpinned cannot tell a guard that was removed from one that was never exercised.
	 */
	describe("every unreadable input is 11, never a pass", () => {
		// The parent lookup is scripted to its proven-standalone 404 so this case isolates the issue
		// read: without its guard the derivation would run to completion and answer `eligible`.
		it("the issue itself", async () => {
			const out = await run([
				[ISSUE, GATEWAY],
				[PARENT, NOT_FOUND],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toBe(
				'build eligible: cannot read #4312: gh: Bad gateway (HTTP 502) — eligibility is UNKNOWN, never "eligible".',
			);
		});

		it("the parent lookup — never 'standalone'", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stderr.at(-1)).toContain('eligibility is UNKNOWN, never "eligible"');
		});

		it("the parent ledger — never 'no dependencies'", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, okOut("4300\n")],
				[LEDGER, GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain("cannot read parent #4300");
		});

		it("a predecessor, with nothing else proven open", async () => {
			const out = await run([
				[ISSUE, issue()],
				[PARENT, okOut("4300\n")],
				[LEDGER, ledger("- phase 1: #210\n- phase 2: #4312")],
				[PRED(210), GATEWAY],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.some((line) => line.includes("cannot read phase predecessor #210"))).toBe(
				true,
			);
		});
	});

	it("an unread predecessor never masks a proven-open one, and is reported beside it", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210, #211\n- phase 2: #4312")],
			[PRED(210), GATEWAY],
			[PRED(211), issue({number: 211, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe(
			"build eligible: blocked by 1 open dependency edge: phase #211.",
		);
		expect(out.stderr.some((line) => line.includes("cannot read phase predecessor #210"))).toBe(
			true,
		);
	});
});
