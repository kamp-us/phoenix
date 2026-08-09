import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDeviations} from "./deviations-verb.ts";
import {DIFF, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const RAW = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;

const SUPPRESSING_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,1 +10,2 @@
 const items = read();
+// @ts-expect-error the types are wrong
diff --git a/src/cart.test.ts b/src/cart.test.ts
--- a/src/cart.test.ts
+++ b/src/cart.test.ts
@@ -12,2 +12,1 @@
 it("renders", () => {
-		expect(renderTotal(10)).toBe("10.00");
`;

const options = {
	pr: 4321,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runDeviations({...options, ...overrides}), fakeShell(script).layer),
	);

describe("runDeviations", () => {
	it("prints none-declared for a `None.` body with a clean diff", async () => {
		const out = await run([
			[PULL, pull()],
			[RAW, okOut(DIFF)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("deviations\tnone-declared\n");
	});

	it("makes a falsified `None.` visible in one read — the claim beside the hits", async () => {
		const out = await run([
			[PULL, pull()],
			[RAW, okOut(SUPPRESSING_DIFF)],
		]);
		expect(out.stdout).toBe(
			[
				"deviations\tnone-declared",
				"tier-m\tsuppression\tsrc/cart.ts:11\t@ts-expect-error",
				'tier-m\tremoved-assertion\tsrc/cart.test.ts:13\texpect(renderTotal(10)).toBe("10.00");',
				"",
			].join("\n"),
		);
	});

	it("prints an entry's label and the first line of its Said", async () => {
		const body =
			"## Deviations\n\n- **Pre-existing test or fixture changed** — **Said:** replaced the two-decimal rendering assertion. **Did:** dropped it.";
		const out = await run([
			[PULL, pull({body})],
			[RAW, okOut(DIFF)],
		]);
		expect(out.stdout).toBe(
			["deviations\tfound", "entry\t6\treplaced the two-decimal rendering assertion.", ""].join(
				"\n",
			),
		);
	});

	it("keeps absent distinct from none-declared — the skill's verdict depends on it", async () => {
		const out = await run([
			[PULL, pull({body: "Fixes #4287\n"})],
			[RAW, okOut(DIFF)],
		]);
		expect(out.stdout).toBe("deviations\tabsent\n");
	});

	it("refuses a truncated diff on 13 — a partial scan must not print beside a claim", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[RAW, okOut(DIFF)],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing a partial Tier-M scan beside a disclosure claim");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review deviations: PR #4321 not found in o/r.");
	});

	it("refuses an unreadable body or diff on 11, and never answers `none`", async () => {
		for (const script of [
			[[PULL, errOut("gh: Bad gateway (HTTP 502)")]] as const,
			[
				[PULL, pull()],
				[RAW, errOut("gh: Bad gateway (HTTP 502)")],
			] as const,
		]) {
			const out = await run(script as ReadonlyArray<readonly [RegExp, ExecResult]>);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain('the disclosure state is UNKNOWN, never "none"');
		}
	});
});
