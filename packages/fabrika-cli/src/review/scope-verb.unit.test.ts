import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {files, HEAD, pull} from "./fixtures.test-support.ts";
import {runScope} from "./scope-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;

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
	Effect.runPromise(Effect.provide(runScope({...options, ...overrides}), fakeShell(script).layer));

const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	[FILES, files("src/cart.ts", "README.md")],
];

describe("runScope", () => {
	it("prints the head, the linked issue, the present classes and the two flags", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`scoped\t${HEAD}\t4287`,
				"class\tcode\t1",
				"class\tdoc\t1",
				"self\tfalse",
				"harness\tfalse",
				"",
			].join("\n"),
		);
	});

	it("emits the record with --json, including the derived namespace set", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "scoped",
			head: HEAD,
			issue: 4287,
			scanned: 2,
			namespaces: ["review-code", "review-doc"],
		});
	});

	it("prints `-` for a PR with no closing keyword, never a fabricated issue", async () => {
		const out = await run([
			[PULL, pull({body: "relates to #4287"})],
			[FILES, files("a.ts", "b.ts")],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\t-`);
	});

	it("reports what it scanned against what was declared", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe("review scope: scanned 2 changed files; 2 declared.");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("review scope: PR #4321 not found in o/r.");
	});

	it("refuses a closed PR on 7 — nothing to review", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review scope: PR #4321 is closed — nothing to review.");
	});

	it("refuses a zero-file PR on 7 rather than classifying an empty review (#4060)", async () => {
		const out = await run([[PULL, pull({changedFiles: 0})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("has zero changed files");
	});

	it("separates an UNREADABLE PR from an absent one — 11, never 7", async () => {
		const out = await run([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("the scope is UNKNOWN");
	});

	it("refuses an unreadable file list on 11 — the partition would be over unknown scope", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a provably short file list on 13, distinct from 11 and 7", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("a.ts", "b.md")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.code).not.toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review scope: file list shows 2 of 9 declared files — refusing to partition a truncated read (#3999).",
		);
	});

	it("refuses a non-PR number, and an unresolvable repo, on 1", async () => {
		expect((await run(happy(), {pr: 0})).code).toBe(1);
		const out = await Effect.runPromise(
			Effect.provide(runScope({...options, env: {}}), fakeShell([]).layer),
		);
		expect(out.code).toBe(1);
	});
});
