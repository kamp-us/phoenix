/**
 * The end-to-end half: the **exit status and the bytes on each channel** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Three spawns cover facts no
 * in-process test can establish: registration, empty stdout on refusal, and non-leakage across the
 * real CLI boundary while reading a temporary Git checkout.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>, cwd?: string): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika pattern, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("lists all five verbs under --help by its registration alone", () => {
		const run = fabrika(["pattern", "--help"]);
		expect(run.code).toBe(0);
		for (const verb of ["corpus", "drift", "anchor", "new", "register"]) {
			expect(run.stdout).toContain(verb);
		}
	});

	it("refuses a non-kebab-case slug on the usage seat with NOTHING on stdout", () => {
		const run = fabrika(["pattern", "new", "Worker_Queue"]);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("is not kebab-case");
	});

	it("derives portable prospective evidence from HEAD despite a staged index addition", () => {
		const root = mkdtempSync(join(tmpdir(), "fabrika-pattern-source-"));
		const upstream = join(root, "xyflow");
		try {
			mkdirSync(join(upstream, "packages/react/src"), {recursive: true});
			writeFileSync(
				join(upstream, "package.json"),
				'{"name":"@xyflow/monorepo","version":"0.0.0","private":true}\n',
			);
			writeFileSync(
				join(upstream, "packages/react/package.json"),
				'{"name":"@xyflow/react","version":"12.11.5"}\n',
			);
			writeFileSync(join(upstream, "packages/react/src/index.ts"), "export {};\n");
			writeFileSync(join(upstream, "packages/react/src/index.test.ts"), "export {};\n");
			writeFileSync(join(upstream, "packages/react/README.md"), "# React\n");
			execFileSync("git", ["init", "-q", upstream]);
			execFileSync("git", [
				"-C",
				upstream,
				"remote",
				"add",
				"origin",
				"git@github.com:xyflow/xyflow.git",
			]);
			execFileSync("git", ["-C", upstream, "add", "."]);
			execFileSync("git", [
				"-C",
				upstream,
				"-c",
				"user.name=Pattern Test",
				"-c",
				"user.email=pattern@example.invalid",
				"commit",
				"-qm",
				"fixture",
			]);
			mkdirSync(join(upstream, "packages/index-only"), {recursive: true});
			writeFileSync(
				join(upstream, "packages/index-only/package.json"),
				'{"name":"@xyflow/react","version":"99.0.0"}\n',
			);
			execFileSync("git", ["-C", upstream, "add", "packages/index-only/package.json"]);

			const run = fabrika(
				[
					"pattern",
					"new",
					"react-flow-shape",
					"--decision",
					"https://github.com/kamp-us/phoenix/issues/7197",
					"--source-repo",
					upstream,
					"--source-package",
					"@xyflow/react",
					"--json",
				],
				root,
			);
			expect(run.code).toBe(0);
			expect(run.stdout).toContain('"origin":"https://github.com/xyflow/xyflow"');
			expect(run.stdout).toContain('"package":"@xyflow/react","version":"12.11.5"');
			expect(run.stdout).not.toContain(upstream);
			const scaffold = readFileSync(join(root, ".patterns/react-flow-shape.md"), "utf8");
			expect(scaffold).toContain("## Prospective scope");
			expect(scaffold).toContain("https://github.com/xyflow/xyflow");
			expect(scaffold).toContain("`@xyflow/react@12.11.5`");
			expect(scaffold).not.toContain(upstream);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});
