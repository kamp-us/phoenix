import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runCriteria} from "./criteria-verb.ts";
import {issue} from "./fixtures.test-support.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4287$/;

const options = {
	issue: 4287,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runCriteria({...options, ...overrides}), fakeShell(script).layer),
	);

describe("runCriteria", () => {
	it("prints the count and one line per criterion, in the wire format's own grammar", async () => {
		const out = await run([[ISSUE, issue()]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"criteria\t2",
				"open\tthe first retry delay equals `base`",
				"checked\tthe retry guide documents the delay table",
				"",
			].join("\n"),
		);
	});

	it("emits the record with --json", async () => {
		const out = await run([[ISSUE, issue()]], {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({outcome: "criteria", issue: 4287, count: 2});
	});

	it("reads a CLOSED issue's contract anyway, with a notice — a re-review is legitimate", async () => {
		const out = await run([[ISSUE, issue(undefined, "closed")]]);
		expect(out.code).toBe(0);
		expect(out.stderr[0]).toContain("#4287 is closed");
	});

	it("refuses an issue proven absent on 7", async () => {
		const out = await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review criteria: issue #4287 not found in o/r.");
	});

	it("refuses an ABSENT block on 7, naming the wire reason", async () => {
		const out = await run([[ISSUE, issue("no contract here")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("carries no acceptance-criteria block — absent:");
		expect(out.stderr.at(-1)).toContain("Grade nothing; the contract is missing.");
	});

	it("reds a DRIFTED heading as malformed — never as `there were none`", async () => {
		const out = await run([[ISSUE, issue("## Acceptance Criteria\n\n- [ ] a thing\n")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("is malformed:");
		expect(out.stderr.at(-1)).toContain('not "there were none"');
	});

	it("gives absent and malformed the same code and never the same message", async () => {
		const absent = await run([[ISSUE, issue("nothing")]]);
		const malformed = await run([[ISSUE, issue("## Acceptance Criteria\n\n- [ ] x\n")]]);
		expect(absent.code).toBe(malformed.code);
		expect(absent.stderr.at(-1)).not.toBe(malformed.stderr.at(-1));
	});

	it("refuses an unreadable issue on 11 — whether a block exists is UNKNOWN", async () => {
		const out = await run([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("whether a block exists is UNKNOWN");
	});
});
