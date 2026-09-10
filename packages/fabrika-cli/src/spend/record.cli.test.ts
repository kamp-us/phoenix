import {spawn, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
	return join(dir, "usage.jsonl");
};
const call = (args: string[], input?: unknown) =>
	spawnSync(process.execPath, [cli, "spend", ...args], {
		encoding: "utf8",
		input: input === undefined ? undefined : JSON.stringify(input),
	});

describe("spend record CLI", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("serializes separate recorder processes using the same ledger", async () => {
		const path = ledger();
		const results = await Promise.all(
			Array.from(
				{length: 4},
				() =>
					new Promise<{status: number | null; stdout: string; stderr: string}>(
						(resolve, reject) => {
							const child = spawn(process.execPath, [cli, "spend", "record", "--ledger", path]);
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
		expect(JSON.parse(call(["read", "--ledger", path]).stdout).records).toEqual([fixture]);
	});

	it("records through the CLI and reads every supplied field in a new process", () => {
		const path = ledger();
		const recorded = call(["record", "--ledger", path], fixture);
		expect(recorded.status, recorded.stderr).toBe(0);
		const read = call(["read", "--ledger", path, "--json"]);
		expect(read.status, read.stderr).toBe(0);
		expect(JSON.parse(read.stdout).records).toEqual([fixture]);
	});

	it("deduplicates copied history and keeps a genuine attempt separate", () => {
		const path = ledger();
		expect(call(["record", "--ledger", path], fixture).status).toBe(0);
		const copy = {...fixture, recordId: "copied-parent-history"};
		const repeated = call(["record", "--ledger", path], copy);
		expect(JSON.parse(repeated.stdout).status).toBe("duplicate");
		const retry = {...fixture, work: {...fixture.work, attempt: "attempt-2"}};
		expect(call(["record", "--ledger", path], retry).status).toBe(0);
		expect(JSON.parse(call(["read", "--ledger", path]).stdout).records).toHaveLength(2);
	});
});
