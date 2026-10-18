import {spawn, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const cli = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/attributed/codex.json", import.meta.url), "utf8"),
);
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const ledger = () => {
	const dir = mkdtempSync(join(tmpdir(), "spend-record-"));
	dirs.push(dir);
	writeFileSync(join(dir, ".fabrika.jsonc"), JSON.stringify({usageCollection: "off"}));
	return join(dir, "usage.jsonl");
};
const call = (path: string, ...args: string[]) =>
	spawnSync(process.execPath, [cli, "spend", ...args, "--ledger", path], {
		cwd: dirname(path),
		encoding: "utf8",
	});

describe("spend record CLI", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("serializes explicit recorder processes with automatic collection off and reads their facts", async () => {
		const path = ledger();
		const results = await Promise.all(
			Array.from(
				{length: 4},
				() =>
					new Promise<{status: number | null; stdout: string; stderr: string}>(
						(resolve, reject) => {
							const child = spawn(process.execPath, [cli, "spend", "record", "--ledger", path], {
								cwd: dirname(path),
							});
							let stdout = "";
							let stderr = "";
							child.stdout.on("data", (chunk) => {
								stdout += chunk;
							});
							child.stderr.on("data", (chunk) => {
								stderr += chunk;
							});
							child.on("error", reject);
							child.on("close", (status) => resolve({status, stdout, stderr}));
							child.stdin.end(JSON.stringify(fixture));
						},
					),
			),
		);
		for (const result of results) expect(result.status, result.stderr).toBe(0);
		expect(
			results.filter((result) => JSON.parse(result.stdout).status === "recorded"),
		).toHaveLength(1);
		expect(JSON.parse(call(path, "read").stdout).records).toEqual([fixture]);
		expect(JSON.parse(call(path, "rollup", "--json").stdout).usage.responses).toBe(1);
	});
});
