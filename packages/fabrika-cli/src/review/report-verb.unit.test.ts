import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {pull} from "./fixtures.test-support.ts";
import {runReport} from "./report-verb.ts";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321$/;

const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const options = {
	pr: 4321,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runReport({...options, ...overrides}), fakeSeams(script).layer));

const REPORTING =
	"does a thing\n\n## Report\n\nAudit scope: every caller of `refocus()`.\n\n## Deviations\n\nNone.\n\nFixes #4287\n";

describe("runReport", () => {
	it("prints the state line, then the report's text", async () => {
		const out = await run([[PULL, served(pull({body: REPORTING}))]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("report\tfound\nAudit scope: every caller of `refocus()`.\n");
	});

	it("carries the same answer as one object under --json", async () => {
		const out = await run([[PULL, served(pull({body: REPORTING}))]], {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "found",
			text: "Audit scope: every caller of `refocus()`.",
		});
	});

	// The case a report-shaped criterion grades FAIL on: the body was read and holds no section, so
	// the answer is a state word at exit 0 and never an unread input.
	it("answers `absent` at exit 0 for a body that was read and carries no section", async () => {
		const out = await run([[PULL, served(pull())]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("report\tabsent\n");
		expect(out.stderr.at(-1)).toBe(
			'review report: absent — no heading in the body reaches for "## Report".',
		);
	});

	it("refuses on 11 with nothing on stdout when the body could not be read", async () => {
		const out = await run([[PULL, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the report state is UNKNOWN, never "absent".');
	});

	it("refuses on 7 when the PR is proven absent", async () => {
		const out = await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review report: PR #4321 not found in o/r.");
	});
});
