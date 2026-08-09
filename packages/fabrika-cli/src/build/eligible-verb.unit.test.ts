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

	it("refuses on 16 and NAMES the first open edge", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210\n- phase 2: #4312\n- #4312 requires: #210")],
			[PRED(210), issue({number: 210, state: "open"})],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by open requires: edge #210.");
	});

	it("treats a ledger-local ref as an open edge — unfiled work is open work", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: C1\n- phase 2: #4312")],
		]);
		expect(out.code).toBe(BLOCKED);
		expect(out.stderr.at(-1)).toBe("build eligible: blocked by open phase edge C1.");
		expect(out.stderr.some((line) => line.includes("names work not yet filed"))).toBe(true);
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

	it("refuses an unreadable parent lookup on 11 — never 'standalone'", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('eligibility is UNKNOWN, never "eligible"');
	});

	it("refuses an unreadable predecessor on 11 — never a pass", async () => {
		const out = await run([
			[ISSUE, issue()],
			[PARENT, okOut("4300\n")],
			[LEDGER, ledger("- phase 1: #210\n- phase 2: #4312")],
			[PRED(210), errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
