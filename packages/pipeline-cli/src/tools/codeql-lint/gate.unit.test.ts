/**
 * `checkCodeqlLint` over a fake repo dir — the filesystem-seam test (#855, issue #2261).
 * The pure verdict is covered in `codeql-lint.unit.test.ts`; this crosses the IO gate
 * over a real temp tree, asserting the exit-code contract from observable outcomes —
 * never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkCodeqlLint} from "./gate.ts";

/** The gate-fail reason, or "" for a non-CheckFailed failure. */
const failReason = (exit: Exit.Exit<void, unknown>): string => {
	if (!Exit.isFailure(exit)) return "";
	const err = Cause.squash(exit.cause);
	return err instanceof CheckFailed ? err.reason : "";
};

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeql-lint-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const write = (rel: string, contents: string) => {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), {recursive: true});
	writeFileSync(abs, contents, "utf8");
};

const WORKFLOW_OK = [
	"name: x",
	"permissions:",
	"  contents: read",
	"jobs:",
	"  a:",
	"    runs-on: x",
].join("\n");
const WORKFLOW_BAD = ["name: y", "jobs:", "  a:", "    runs-on: x"].join("\n");

const run = (baseline?: object) => {
	if (baseline) write(".github/codeql-lint-baseline.json", JSON.stringify(baseline));
	return Effect.runPromiseExit(checkCodeqlLint(root));
};

describe("checkCodeqlLint", () => {
	it("fails closed on zero scope (no workflows, no source)", async () => {
		const exit = await run();
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("passes a clean tree (pinned workflow + linear regex)", async () => {
		write(".github/workflows/x.yml", WORKFLOW_OK);
		write("packages/p/a.ts", "export const re = /^[a-z]+(-[a-z]+)*$/;\n");
		const exit = await run();
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("fails on a workflow missing permissions", async () => {
		write(".github/workflows/y.yml", WORKFLOW_BAD);
		const exit = await run();
		expect(Exit.isFailure(exit)).toBe(true);
		expect(failReason(exit)).toContain("workflow-permissions");
	});

	it("fails on a catastrophic regex in source", async () => {
		write(".github/workflows/x.yml", WORKFLOW_OK);
		write("apps/web/src/bad.ts", "export const re = /(\\w+)+$/;\n");
		const exit = await run();
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("grandfathers a baselined workflow", async () => {
		write(".github/workflows/y.yml", WORKFLOW_BAD);
		write("packages/p/a.ts", "export const ok = /(a|b)+/;\n");
		const exit = await run({
			grandfatheredWorkflows: [".github/workflows/y.yml"],
			grandfatheredRegexes: [],
		});
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("fails closed on a malformed baseline file", async () => {
		write(".github/workflows/x.yml", WORKFLOW_OK);
		const exit = await run({grandfatheredWorkflows: "not-an-array"});
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("skips node_modules / dist / *.d.ts when walking source", async () => {
		write(".github/workflows/x.yml", WORKFLOW_OK);
		write("packages/p/node_modules/dep/bad.ts", "export const re = /(a+)+/;\n");
		write("packages/p/dist/bad.js", "export const re = /(a+)+/;\n");
		write("packages/p/types.d.ts", "export const re: RegExp;\n");
		const exit = await run();
		expect(Exit.isSuccess(exit)).toBe(true);
	});
});
