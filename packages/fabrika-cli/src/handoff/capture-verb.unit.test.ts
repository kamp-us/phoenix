import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {runCapture} from "./capture-verb.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	BASE,
	GROUND,
	groundScript,
	ISSUE,
	ISSUE_READ,
	REPO,
	REPO_READ,
} from "./fixtures.test-support.ts";

const options = {
	issue: ISSUE,
	base: null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
	now: () => new Date("2026-08-09T18:36:48.000Z"),
};

const run = (script: ReadonlyArray<Scripted>, over: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runCapture({...options, ...over}), fakeSeams(script).layer));

describe("runCapture", () => {
	it("exits 0 with the whole ground state on stdout", async () => {
		const out = await run(groundScript());
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual(GROUND);
		expect(out.stderr.join("\n")).toContain(`base ${BASE}`);
	});

	it("reports no pull request as the FACT null, not as an absence", async () => {
		const out = await run([[/pulls\?state=all/, {status: 200, body: "[]"}], ...groundScript()]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).board.pull).toBeNull();
	});

	it("exits 7 on an issue that does not exist", async () => {
		const out = await run([
			[ISSUE_READ, {status: 404, body: '{"message":"Not Found"}'}],
			...groundScript(),
		]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
	});

	it("exits 11 when a git read failed — the ground is UNKNOWN, never clean", async () => {
		const out = await run([
			[/status --porcelain/, errOut("not a git repository")],
			...groundScript(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("never clean");
	});

	it("exits 11 when the check-run rollup could not be read — reporting none would claim a read that failed", async () => {
		const out = await run([[/check-runs/, {status: 502, body: "{}"}], ...groundScript()]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 11 when the default branch could not be read, rather than guessing one", async () => {
		const out = await run([[REPO_READ, {status: 502, body: "{}"}], ...groundScript()]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
