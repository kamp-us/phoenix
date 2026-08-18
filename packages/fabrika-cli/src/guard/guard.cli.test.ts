/**
 * The end-to-end half: the **exit status and the bytes on each channel** a workflow step reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Four spawns, each about a fact
 * no in-process test can establish: that the nested `guard <name> check` path is reachable by its
 * registration alone, that a violation really does cross the process boundary as a distinct
 * non-zero code, and that zero scope reds rather than passing (ADR 0092). One spawn per registered
 * guard covers the registration; the taxonomy is proven once, on readme-guard.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {VIOLATION, ZERO_SCOPE} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1", GITHUB_ACTIONS: "false"},
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

/** A throwaway repo root: a workspace file plus whatever members the case needs. */
const fixture = (members: Readonly<Record<string, ReadonlyArray<string>>>): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-guard-"));
	writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
	mkdirSync(join(root, "packages"), {recursive: true});
	for (const [name, held] of Object.entries(members)) {
		mkdirSync(join(root, "packages", name), {recursive: true});
		for (const file of held) writeFileSync(join(root, "packages", name, file), "x", "utf8");
	}
	return root;
};

describe("fabrika guard, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("passes a clean tree, with the summary on stdout", () => {
		const root = fixture({a: ["package.json", "README.md"]});
		const run = fabrika(["guard", "readme-guard", "check", "--root", root]);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("carry a README.md");
	});

	it("reds a README-less member on the violation seat with NOTHING on stdout", () => {
		const root = fixture({a: ["package.json"]});
		const run = fabrika(["guard", "readme-guard", "check", "--root", root]);
		expect(run.code).toBe(VIOLATION);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("packages/a");
	});

	it("reds an empty scope rather than passing it (ADR 0092)", () => {
		const run = fabrika(["guard", "readme-guard", "check", "--root", fixture({})]);
		expect(run.code).toBe(ZERO_SCOPE);
		expect(run.stdout).toBe("");
	});

	it("reaches skill-lint by its registration alone, and reds a real violation there", () => {
		const root = mkdtempSync(join(tmpdir(), "fabrika-skill-lint-"));
		mkdirSync(join(root, "claude-plugins", "p"), {recursive: true});
		writeFileSync(
			join(root, "claude-plugins", "p", "SKILL.md"),
			[
				"---",
				"name: p",
				"description: a skill.",
				"---",
				"",
				"```bash",
				"gh pr edit 5",
				"```",
				"",
			].join("\n"),
			"utf8",
		);
		const run = fabrika(["guard", "skill-lint", "check", "--root", root]);
		expect(run.code).toBe(VIOLATION);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("gh pr edit");
	});
});
