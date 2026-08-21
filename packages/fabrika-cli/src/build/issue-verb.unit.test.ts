import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {GATEWAY, issue, NOT_FOUND} from "./fixtures.test-support.ts";
import {runIssue} from "./issue-verb.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(runIssue(options), fakeSeams(script).layer));

describe("runIssue", () => {
	it("carries the body and the criteria rows through", async () => {
		const out = await run([
			[
				ISSUE,
				issue({
					body: "### Acceptance criteria\n\n- [ ] focus stays in the editor after save\n- [x] a test covers it\n",
				}),
			],
		]);
		expect(out.code).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.number).toBe(4312);
		expect(parsed.labels).toEqual(["type:bug", "p1", "status:triaged"]);
		expect(parsed.criteria.state).toBe("found");
		expect(parsed.criteria.items).toEqual([
			{text: "focus stays in the editor after save", checked: false},
			{text: "a test covers it", checked: true},
		]);
	});

	it("reports a genuinely absent block as `absent`, on exit 0", async () => {
		const out = await run([[ISSUE, issue({body: "just a description\n"})]]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).criteria.state).toBe("absent");
	});

	/**
	 * The whole reason the wire read has three arms: a heading that reaches for the block and misses is
	 * a DEFECT the skill must surface, and flattening it into `absent` is how a gate grades over
	 * nothing (#4735's class).
	 */
	it("reports a drifted heading as `malformed`, never as `absent`", async () => {
		const out = await run([
			[ISSUE, issue({body: "### Acceptance Criteria\n\n- [ ] focus stays put\n"})],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.criteria.state).toBe("malformed");
	});

	it("refuses a proven-absent issue on 7", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("build issue: issue #4312 is proven absent or closed.");
	});

	it("refuses a closed issue on 7 too", async () => {
		const out = await run([[ISSUE, issue({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("refuses an unreadable issue on 11 — its content is UNKNOWN", async () => {
		const out = await run([[ISSUE, GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("its content is UNKNOWN");
	});
});
