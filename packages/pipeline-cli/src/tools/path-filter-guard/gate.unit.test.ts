/**
 * `checkPathFilters` over a fake repo dir — the filesystem-seam test (issue #2372). The
 * pure verdict is covered in `path-filter-guard.unit.test.ts`; this crosses the IO gate
 * over a real temp dir, asserting the exit-code contract from observable outcomes — never
 * by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkPathFilters} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "path-filter-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const mkWorkflow = (key: string, globs: ReadonlyArray<string>): string => {
	const items = globs.map((g) => `              - '${g}'`);
	return [
		"name: T",
		"on:",
		"  pull_request:",
		"jobs:",
		"  changes:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: dorny/paths-filter@v3.0.2",
		"        id: filter",
		"        with:",
		"          filters: |",
		`            ${key}:`,
		...items,
		"",
	].join("\n");
};

const writeWorkflows = (ci: string | null, deploy: string | null) => {
	const dir = join(root, ".github", "workflows");
	mkdirSync(dir, {recursive: true});
	if (ci !== null) writeFileSync(join(dir, "ci.yml"), ci, "utf8");
	if (deploy !== null) writeFileSync(join(dir, "deploy.yml"), deploy, "utf8");
};

const SAMPLE = ["apps/**/src/**", "apps/**/worker/**"];
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkPathFilters — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when the two filter sets are identical (the proof)", async () => {
		writeWorkflows(mkWorkflow("e2e", SAMPLE), mkWorkflow("deploy", SAMPLE));
		const exit = await run(checkPathFilters(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when the two filter sets drift apart (the falsification)", async () => {
		writeWorkflows(
			mkWorkflow("e2e", [...SAMPLE, "apps/**/index.html"]),
			mkWorkflow("deploy", SAMPLE),
		);
		const exit = await run(checkPathFilters(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (fail-closed) when a workflow file is missing (IoError)", async () => {
		writeWorkflows(mkWorkflow("e2e", SAMPLE), null);
		const exit = await run(checkPathFilters(root));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) on zero scope (empty deploy list)", async () => {
		writeWorkflows(mkWorkflow("e2e", SAMPLE), mkWorkflow("deploy", []));
		const exit = await run(checkPathFilters(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
