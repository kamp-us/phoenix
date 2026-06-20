import {execFile} from "node:child_process";
import {copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {degradedAllow, depsInstalled, RUNTIME_DEP} from "./preflight.ts";

describe("preflight — runtime-dep probe (#777)", () => {
	it("resolves the real runtime dep as installed", () => {
		assert.isTrue(depsInstalled(RUNTIME_DEP));
	});
	it("reports a non-existent package as NOT installed", () => {
		assert.isFalse(depsInstalled("@kampus/this-does-not-exist-777"));
	});
	it("never throws on a bogus specifier", () => {
		assert.doesNotThrow(() => depsInstalled("totally-bogus"));
	});
	it("degraded output is a fail-open allow (matches the unset-root no-op posture)", () => {
		assert.strictEqual(JSON.parse(degradedAllow()).hookSpecificOutput.permissionDecision, "allow");
	});
});

const SRC = dirname(fileURLToPath(new URL("./bin.ts", import.meta.url)));

const runIsolated = (
	isoBin: string,
	args: ReadonlyArray<string>,
	stdin: string,
): Promise<{code: number; stdout: string; stderr: string}> =>
	new Promise((resolve) => {
		const {NODE_PATH: _drop, ...env} = process.env;
		const child = execFile("node", [isoBin, ...args], {env}, (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
		child.stdin?.end(stdin);
	});

describe("bin — missing-dep degradation over the real entrypoint (#777)", () => {
	let isoDir: string;
	beforeAll(() => {
		isoDir = mkdtempSync(join(tmpdir(), "worktree-guard-nodeps-"));
		// builtin-only modules; bin.run.ts (the platform-node importer) intentionally omitted.
		for (const f of [
			"bin.ts",
			"preflight.ts",
			"bash-pin.ts",
			"enter-guard.ts",
			"path-resolve.ts",
			"reap.ts",
		]) {
			copyFileSync(join(SRC, f), join(isoDir, f));
		}
	});
	afterAll(() => rmSync(isoDir, {recursive: true, force: true}));

	it("pre-file degrades to fail-open ALLOW with a loud stderr note", async () => {
		const {code, stdout, stderr} = await runIsolated(
			join(isoDir, "bin.ts"),
			["pre-file"],
			JSON.stringify({tool_input: {file_path: "/tmp/x"}}),
		);
		assert.strictEqual(code, 0);
		assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
		assert.include(stderr, "@effect/platform-node");
		assert.include(stderr, "pnpm install");
	}, 30_000);

	it("reap degrades to a skip (no stdout) with a loud stderr note", async () => {
		const {code, stdout, stderr} = await runIsolated(join(isoDir, "bin.ts"), ["reap"], "{}");
		assert.strictEqual(code, 0);
		assert.strictEqual(stdout.trim(), "");
		assert.include(stderr, "@effect/platform-node");
	}, 30_000);
});
