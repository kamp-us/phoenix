/**
 * The end-to-end half: the **exit status and the bytes on each channel** a workflow step reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Each `it` is about a fact no
 * in-process test can establish: that the nested `guard <name> check` path is reachable by its
 * registration alone, that a violation really does cross the process boundary as a distinct
 * non-zero code, and that zero scope reds rather than passing (ADR 0092). One spawn per registered
 * guard covers the registration; the taxonomy is proven once, on readme-guard.
 *
 * The four BOARD guards reach GitHub, so their registration spawn resolves the leaf and stops
 * there. Running one for real would put the network in a unit suite and make the verdict a fact
 * about the live board — registration is the only thing a spawn adds over their verb tests, and it
 * is exactly what resolving the leaf proves: an unregistered path exits on the unknown-subcommand
 * refusal instead.
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

	it.each([
		["homing-guard", "standing-lane"],
		["pitch-guard", "Rabbit-holes"],
		["roadmap-guard", "milestone"],
		["unresolved-threads-guard", "review-code"],
	])("reaches %s's check leaf by its registration alone", (guard, marker) => {
		const run = fabrika(["guard", guard, "check", "--help"]);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(marker);
	});

	// The #5720 CI-shape and canon/design batch. Two of these leaves are NOT named `check`, which
	// is the whole reason to spawn them: a leaf mis-registered under the wrong name is invisible to
	// every in-process test and shows up only as an unknown-subcommand refusal in CI.
	it.each([
		["path-filter-guard", "check", "Example: fabrika guard path-filter-guard check"],
		["change-detect-guard", "check", "Example: fabrika guard change-detect-guard check"],
		["codeowners-cp", "check", "Example: fabrika guard codeowners-cp check"],
		["decisions-index", "validate", "ADR 0074"],
		["design-token-guard", "check", "ADR 0162"],
		["design-inventory", "check", "ADR 0194"],
		["design-inventory", "generate", "ADR 0194"],
		["no-gh", "check", "Example: fabrika guard no-gh check"],
	])("reaches %s's %s leaf by its registration alone", (guard, leaf, marker) => {
		const run = fabrika(["guard", guard, leaf, "--help"]);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(marker);
	});

	it("reds a duplicate ADR id through the real decisions-index leaf", () => {
		const root = mkdtempSync(join(tmpdir(), "fabrika-decisions-"));
		mkdirSync(join(root, ".decisions"), {recursive: true});
		const record = "---\nid: 0284\ntitle: A title\nstatus: accepted\ndate: 2026-08-18\n---\n";
		writeFileSync(join(root, ".decisions", "0284-one.md"), record, "utf8");
		writeFileSync(join(root, ".decisions", "0284-two.md"), record, "utf8");
		const run = fabrika(["guard", "decisions-index", "validate", "--root", root]);
		expect(run.code).toBe(VIOLATION);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("duplicate ADR id 0284");
	});
});
