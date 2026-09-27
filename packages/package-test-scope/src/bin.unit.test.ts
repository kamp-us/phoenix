import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

/** Runs the bin against this checkout's real workspace and returns its `$GITHUB_OUTPUT` lines. */
const run = (env: Record<string, string>, changedFiles?: ReadonlyArray<string>) => {
	const directory = mkdtempSync(join(tmpdir(), "package-test-scope-"));
	directories.push(directory);
	const output = join(directory, "output");
	const inputs: Record<string, string> = {};
	if (changedFiles !== undefined) {
		inputs.CHANGED_FILES_FILE = join(directory, "files");
		writeFileSync(inputs.CHANGED_FILES_FILE, changedFiles.map((file) => `${file}\0`).join(""));
	}
	const child = spawnSync(process.execPath, [fileURLToPath(new URL("./bin.ts", import.meta.url))], {
		encoding: "utf8",
		env: {PATH: process.env.PATH, GITHUB_OUTPUT: output, ...inputs, ...env},
	});
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	return Object.fromEntries(
		readFileSync(output, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
};

describe("package-test-scope bin over the real workspace", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("scopes a fabrika-cli-only pull request to fabrika-cli", () => {
		const out = run({GITHUB_EVENT_NAME: "pull_request", SCOPE_BASE: "abc123"}, [
			"packages/fabrika-cli/src/bin.ts",
		]);
		expect(out).toMatchObject({
			packages_scope: "scoped",
			packages_selection: "@kampus/fabrika-cli",
			tuval_sdk_proof: "false",
		});
	});

	it("keeps the Tuval SDK proof when a Tuval SDK file changed", () => {
		const out = run({GITHUB_EVENT_NAME: "merge_group", SCOPE_BASE: "abc123"}, [
			"packages/tuval/src/index.ts",
		]);
		expect(out.packages_scope).toBe("scoped");
		expect(out.packages_selection?.split(" ")).toContain("@kampus/tuval-sdk");
		expect(out.tuval_sdk_proof).toBe("true");
	});

	it("runs every package when the changed-file list is missing", () => {
		const out = run({GITHUB_EVENT_NAME: "pull_request", SCOPE_BASE: "abc123"});
		expect(out).toMatchObject({
			packages_scope: "full",
			packages_selection: "",
			tuval_sdk_proof: "true",
		});
	});

	it("runs every package on a push", () => {
		expect(run({GITHUB_EVENT_NAME: "push"}, []).packages_scope).toBe("full");
	});
});
