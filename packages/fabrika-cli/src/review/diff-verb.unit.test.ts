import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDiff} from "./diff-verb.ts";
import {DIFF, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const RAW = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;

const options = {
	pr: 4321,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runDiff({...options, ...overrides}), fakeShell(script).layer));

describe("runDiff", () => {
	it("serves the diff bytes exactly as the platform did", async () => {
		const out = await run([
			[PULL, pull()],
			[RAW, okOut(DIFF)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(DIFF);
	});

	it("reports the file and byte counts it proved the diff against", async () => {
		const out = await run([
			[PULL, pull()],
			[RAW, okOut(DIFF)],
		]);
		expect(out.stderr[0]).toContain("scanned 2 files; 2 declared");
		expect(out.stderr[0]).toContain("bytes");
	});

	it("refuses a truncated diff on 13 rather than serving the prefix as the whole", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 7})],
			[RAW, okOut(DIFF)],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review diff: the diff for #4321 is truncated (2 of 7 files) — refusing to serve a partial diff as the whole (#3925's class).",
		);
	});

	it("makes the same zero-file refusal `review scope` does, so neither serves a review over nothing", async () => {
		const out = await run([[PULL, pull({changedFiles: 0})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain(
			"refusing to serve an empty diff as a reviewable one (ADR 0092).",
		);
	});

	it("refuses an absent PR on 7 and an unreadable diff on 11", async () => {
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		const unreadable = await run([
			[PULL, pull()],
			[RAW, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(unreadable.code).toBe(PRECONDITION_UNKNOWN);
		expect(unreadable.stdout).toBe("");
		expect(unreadable.stderr.at(-1)).toContain("UNKNOWN");
	});
});
