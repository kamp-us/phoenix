/**
 * The live stage vocabulary, asserted where an operator actually meets it: the `fabrika eval`
 * process (#4978).
 *
 * A unit assertion on `STAGES` proves the tuple changed; only a real run proves the flag validation
 * that reads it did. Both stage flags are checked, because they validate through different code
 * paths (`isStageName` in `spawn.ts` for `--stage`, a local `isStage` in `command.ts` for
 * `--baseline-stage`) and a re-key that fixed only one would read green here otherwise.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const EVAL_SET = fileURLToPath(new URL("./fixtures/skill-creator/evals.json", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whichever install a root pins. */
const fabrika = (...args: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

const evalRun = (stage: string): Run =>
	fabrika(
		"eval",
		"run",
		EVAL_SET,
		"--stage",
		stage,
		"--plugin-dir",
		"/nonexistent-plugin-dir",
		"--model",
		"test-model",
		"--dry-run",
	);

const emptyRowsFile = (): string => {
	const path = join(mkdtempSync(join(tmpdir(), "fabrika-stage-vocab-")), "rows.json");
	writeFileSync(path, "[]\n");
	return path;
};

describe("the live stage vocabulary is what fabrika eval accepts", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("--stage build is accepted", () => {
		const run = evalRun("build");
		expect(run.code).toBe(0);
		expect(run.stderr).not.toMatch(/not a known stage/);
	});

	it("--stage write-code is refused, naming the stages that do exist", () => {
		const run = evalRun("write-code");
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("--stage 'write-code' is not a known stage");
		expect(run.stderr).toContain("build");
		expect(run.stderr).not.toMatch(/\(.*write-code.*\)/);
	});

	it("--baseline-stage write-code is refused and --baseline-stage build is accepted", () => {
		const rows = emptyRowsFile();
		const refused = fabrika("eval", "report", rows, "--baseline-stage", "write-code");
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("--baseline-stage 'write-code' is not a known stage");

		const accepted = fabrika("eval", "report", rows, "--baseline-stage", "build");
		expect(accepted.code).toBe(0);
	});

	it("--stage review is accepted", () => {
		const run = evalRun("review");
		expect(run.code).toBe(0);
		expect(run.stderr).not.toMatch(/not a known stage/);
	});

	for (const v1 of ["review-code", "review-doc"]) {
		it(`--stage ${v1} is refused, naming the stages that do exist`, () => {
			const run = evalRun(v1);
			expect(run.code).not.toBe(0);
			expect(run.stderr).toContain(`--stage '${v1}' is not a known stage`);
			// The refusal names the live vocabulary, and the v1 key is not offered back inside it.
			expect(run.stderr).toContain("(triage, build, review, ship-it)");
			expect(run.stderr).not.toMatch(/\([^)]*review-(code|doc)/);
		});

		it(`--baseline-stage ${v1} is refused`, () => {
			const refused = fabrika("eval", "report", emptyRowsFile(), "--baseline-stage", v1);
			expect(refused.code).not.toBe(0);
			expect(refused.stderr).toContain(`--baseline-stage '${v1}' is not a known stage`);
		});
	}

	it("--baseline-stage review is accepted when it names a surface", () => {
		const accepted = fabrika(
			"eval",
			"report",
			emptyRowsFile(),
			"--baseline-stage",
			"review",
			"--baseline-surface",
			"code",
		);
		expect(accepted.code).toBe(0);
	});

	// A `review` baseline with no surface names two graders, so it identifies no cell — refused at
	// the flag rather than resolved to whichever surface happens to bucket first (ADR 0243 §4).
	it("--baseline-stage review with no --baseline-surface is refused, naming the surfaces", () => {
		const refused = fabrika("eval", "report", emptyRowsFile(), "--baseline-stage", "review");
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("--baseline-stage review needs --baseline-surface");
		expect(refused.stderr).toContain("code, doc, skill");
	});

	it("--baseline-surface skill is accepted — it is one of ADR 0243's three surfaces", () => {
		const accepted = fabrika(
			"eval",
			"report",
			emptyRowsFile(),
			"--baseline-stage",
			"review",
			"--baseline-surface",
			"skill",
		);
		expect(accepted.code).toBe(0);
	});

	it("--baseline-surface names a surface outside the three and is refused", () => {
		const refused = fabrika(
			"eval",
			"report",
			emptyRowsFile(),
			"--baseline-stage",
			"review",
			"--baseline-surface",
			"design",
		);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("'design' is not a known review surface");
	});

	it("--baseline-surface on a non-review stage is refused", () => {
		const refused = fabrika(
			"eval",
			"report",
			emptyRowsFile(),
			"--baseline-stage",
			"build",
			"--baseline-surface",
			"code",
		);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("--baseline-surface only applies to --baseline-stage review");
	});
});
