/**
 * `checkChangeDetect` over a fake repo dir — the filesystem-seam test (#3245). The pure
 * verdict is covered in `change-detect-guard.unit.test.ts`; this crosses the IO gate over a
 * real temp dir, asserting the exit-code contract from observable outcomes — never by
 * spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkChangeDetect} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "change-detect-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const mkCi = (withLines: ReadonlyArray<string>): string =>
	[
		"name: CI",
		"on:",
		"  pull_request:",
		"jobs:",
		"  changes:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: dorny/paths-filter@v3.0.2",
		"        id: filter",
		"        with:",
		...withLines.map((l) => `          ${l}`),
		"",
	].join("\n");

const writeCi = (ci: string | null) => {
	const dir = join(root, ".github", "workflows");
	mkdirSync(dir, {recursive: true});
	if (ci !== null) writeFileSync(join(dir, "ci.yml"), ci, "utf8");
};

const GIT_MODE = ["token: ''", "filters: |", "  code:", "    - 'packages/**'"];
const API_MODE = ["token: ${{ github.token }}", "filters: |", "  code:", "    - 'packages/**'"];

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkChangeDetect — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when the dorny step sets token: '' (the proof)", async () => {
		writeCi(mkCi(GIT_MODE));
		const exit = await run(checkChangeDetect(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when the dorny step is in GitHub-API mode (the falsification)", async () => {
		writeCi(mkCi(API_MODE));
		const exit = await run(checkChangeDetect(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (fail-closed) when ci.yml is missing (IoError)", async () => {
		writeCi(null);
		const exit = await run(checkChangeDetect(root));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) on zero scope (no dorny step)", async () => {
		writeCi(
			mkCi(GIT_MODE).replace(
				"      - uses: dorny/paths-filter@v3.0.2",
				"      - uses: some/other-action@v1",
			),
		);
		const exit = await run(checkChangeDetect(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
