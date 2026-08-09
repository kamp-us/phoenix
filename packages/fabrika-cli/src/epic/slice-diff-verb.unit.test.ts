import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	COMMIT_NOT_IN_GRAPH,
	NOT_A_WORKTREE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {EPIC, LANDED, LINKED, REV_PARSE} from "./fixtures.test-support.ts";
import {runSliceDiff} from "./slice-diff-verb.ts";

const RESOLVE = /^git rev-parse --verify --quiet [0-9a-f]+\^\{commit\}$/;
const SHOW = /^git show --format= --patch/;

const DIFF = `diff --git a/src/totals.ts b/src/totals.ts
index 0b1c2d3..a1b2c3d 100644
--- a/src/totals.ts
+++ b/src/totals.ts
@@ -1 +1 @@
-old
+new
`;

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
	[RESOLVE, okOut(`${LANDED}\n`)],
	[SHOW, okOut(DIFF)],
];

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]> = WORLD, commit = "8c1f2a9d") =>
	Effect.runPromise(Effect.provide(runSliceDiff({number: EPIC, commit}), fakeShell(script).layer));

describe("runSliceDiff", () => {
	it("serves the commit's diff bytes with no header of its own", async () => {
		const outcome = await run();
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(DIFF);
	});

	it("runs the TREE assertion only — an evaluator holds no claim, so nothing reads GitHub", async () => {
		const shell = fakeShell(WORLD);
		await Effect.runPromise(
			Effect.provide(runSliceDiff({number: EPIC, commit: "8c1f2a9d"}), shell.layer),
		);
		expect(shell.calls.some((call) => call.startsWith("gh "))).toBe(false);
	});

	it("refuses the primary checkout on 12", async () => {
		const outcome = await run([
			[REV_PARSE, okOut(["/repo/.git", "/repo/.git", "/repo"].join("\n"))],
		]);
		expect(outcome.code).toBe(NOT_A_WORKTREE);
	});

	it("refuses a --commit that is not 7–40 lowercase hex on 10, before any git read", async () => {
		expect((await run([], "HEAD")).code).toBe(OFF_VOCABULARY);
		expect((await run([], "8C1F2A9D")).code).toBe(OFF_VOCABULARY);
	});

	it("refuses a commit outside this branch's local graph on 24", async () => {
		const outcome = await run([[RESOLVE, errOut("")], ...WORLD]);
		expect(outcome.code).toBe(COMMIT_NOT_IN_GRAPH);
		expect(outcome.stderr.at(-1)).toContain("nothing to serve");
	});

	it("refuses an empty diff on 7 and a failed read on 11 — never the same code", async () => {
		expect((await run([[SHOW, okOut("\n")], ...WORLD])).code).toBe(ZERO_SCOPE);
		expect((await run([[SHOW, errOut("fatal: bad object")], ...WORLD])).code).toBe(
			PRECONDITION_UNKNOWN,
		);
	});
});
