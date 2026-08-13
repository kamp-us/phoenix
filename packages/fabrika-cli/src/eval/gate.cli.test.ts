/**
 * The merge gate watched failing — the exit status and stream discipline a CI job actually relays.
 *
 * #4681 asks for the guard to be *observed* rather than assumed, and the 2026-08-13 demotion (#5498)
 * splits what there is to observe: a genuinely failing eval case is still watched **red**, while the
 * graded states — **missing**, **stale**, **below-bar** — are watched **green with the debt printed**,
 * which is the demotion's whole claim and the one an assumption would get wrong. Each `it` here runs
 * the real bin in a subprocess and asserts the code a `run:` step would see
 * (`.patterns/subprocess-test-budget.md` bounds the spawn count; every branch of the decision itself
 * lives in `./gate.unit.test.ts`).
 *
 * The floor runs against a corpus authored here rather than the committed one, because the assertion
 * is about the gate's behaviour on a failing case and the committed corpus has none armed yet
 * (#5431). The PR path gets one run through a `gh` shim, which proves the verb resolves head,
 * changed paths and records off the platform — the shape the workflow depends on.
 */
import {spawnSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {REGRESSION_FLOOR, ZERO_SCOPE} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OLDER = "7be402c1d3e5f60718293a4b5c6d7e8f90a1b2c3";
const SKILL_PATH = "claude-plugins/fabrika/skills/triage/SKILL.md";

const CORPUS = {
	skill_name: "fixture-incident-corpus",
	evals: [{id: 1, prompt: "run the guard", expectations: ["The check exits 0."]}],
};

const recordBytes = (sha: string, passed: number, graded: number): string => {
	const cases = Array.from({length: graded}, (_, index) => {
		const passes = index < passed;
		return {
			caseId: index + 1,
			verdict: passes ? "pass" : "fail",
			runs: 5,
			passed: passes ? 5 : 0,
			noVerdict: 0,
			dispersion: 0,
			perRun: Array.from({length: 5}, () => (passes ? "pass" : "fail")),
		};
	});
	return [
		`eval: RECORDED @ ${sha} — a graded run`,
		"",
		"```json",
		JSON.stringify(
			{
				sha,
				recordedAt: "2026-08-11T06:30:00Z",
				cell: {stage: "review", surface: "skill", model: "claude-opus-4-8"},
				pins: {model: "claude-opus-4-8", cli: "2.1.227", harness: "0.1.0"},
				gradedRuns: graded,
				passedRuns: passed,
				unmeasuredCases: 0,
				passRate: Math.round((passed / graded) * 10_000) / 10_000,
				cases,
			},
			null,
			2,
		),
		"```",
		"",
	].join("\n");
};

interface Fixture {
	readonly dir: string;
	readonly args: ReadonlyArray<string>;
}

/** A workspace whose floor arms one case with `command`, and whose changed set is `changed`. */
const fixture = (options: {
	readonly command: string;
	readonly changed: ReadonlyArray<string>;
	readonly records?: ReadonlyArray<string>;
}): Fixture => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-gate-cli-"));
	mkdirSync(join(dir, "series"), {recursive: true});
	writeFileSync(join(dir, "evals.json"), JSON.stringify(CORPUS));
	writeFileSync(
		join(dir, "commands.json"),
		JSON.stringify({
			corpus: "fixture-incident-corpus",
			rows: [{status: "armed", caseId: 1, command: options.command, args: []}],
		}),
	);
	writeFileSync(join(dir, "changed.txt"), `${options.changed.join("\n")}\n`);
	const records = (options.records ?? []).map((bytes, index) => {
		const path = join(dir, `record-${index}.md`);
		writeFileSync(path, bytes);
		return path;
	});
	return {
		dir,
		args: [
			"--head",
			HEAD,
			"--changed",
			join(dir, "changed.txt"),
			"--floor-cases",
			join(dir, "evals.json"),
			"--floor-commands",
			join(dir, "commands.json"),
			"--series-dir",
			join(dir, "series"),
			"--spend-ledger",
			join(dir, "no-such-ledger.jsonl"),
			...records.flatMap((path) => ["--record", path]),
		],
	};
};

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

// `spawnSync` rather than `execFileSync` so a run that EXITS 0 still yields its stderr: since the
// demotion the interesting graded cases are green, and their diagnostics are the thing to assert.
const gate = (args: ReadonlyArray<string>, env: Record<string, string> = {}): Run => {
	const run = spawnSync(process.execPath, [BIN, "eval", "gate", ...args], {
		encoding: "utf8",
		env: {...process.env, FABRIKA_SKIP_INFER: "1", CLAUDE_PIPELINE_REPO: "o/r", ...env},
	});
	return {code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? ""};
};

describe("fabrika eval gate, watched failing", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("passes when the floor passes and no skill changed, and says which legs measured nothing", () => {
		const run = gate(fixture({command: "true", changed: ["packages/fabrika-cli/src/x.ts"]}).args);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("floor: 1/1");
		// The graded leg is n/a and there is no candidate ledger, so two legs measured nothing — and
		// the summary a reader skims must say so rather than report the bar met.
		expect(run.stdout).toContain("gate: NOT FULLY MEASURED");
		expect(run.stdout).toContain("2 of 4 leg(s) measured NOTHING");
		expect(run.stdout).not.toContain("gate: GREEN");
	});

	it("(a) reds `regression-floor` on a genuinely failing incident case", () => {
		const run = gate(fixture({command: "false", changed: ["packages/fabrika-cli/src/x.ts"]}).args);
		expect(run.code).toBe(REGRESSION_FLOOR);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("regression-floor");
		expect(run.stderr).toContain("no tolerance and no quarantine");
	});

	// (b), (c) and (d) are the demotion watched live: a skill change with no record, one whose newest
	// record is stale, and one recorded under the bar all exit 0 and print what they know instead.
	it("(b) goes green and prints the debt when a skill changed and no result was recorded", () => {
		const run = gate(fixture({command: "true", changed: [SKILL_PATH]}).args);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("graded: REPORTED, NOT ENFORCED");
		expect(run.stdout).toContain("a measurement is owed");
		expect(run.stdout).toContain("plain session");
		expect(run.stdout).toContain("gate: NOT FULLY MEASURED");
	});

	it("(c) goes green and names the older commit when the newest result is stale", () => {
		const run = gate(
			fixture({
				command: "true",
				changed: [SKILL_PATH],
				records: [recordBytes(OLDER, 10, 10)],
			}).args,
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(OLDER);
		expect(run.stdout).toContain("graded: REPORTED, NOT ENFORCED");
	});

	it("(d) goes green and still prints the score on a recorded rate under the ruled bar", () => {
		const run = gate(
			fixture({command: "true", changed: [SKILL_PATH], records: [recordBytes(HEAD, 8, 10)]}).args,
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("0.8");
		expect(run.stdout).toContain("under the ruled bar of 0.9");
		expect(run.stdout).toContain("gate: NOT FULLY MEASURED");
	});

	it("passes a skill change whose recorded rate is at the bar", () => {
		const run = gate(
			fixture({command: "true", changed: [SKILL_PATH], records: [recordBytes(HEAD, 9, 10)]}).args,
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("graded: 1 cell(s) recorded");
		expect(run.stdout).toContain("gate: NOT FULLY MEASURED");
	});

	it("reds zero scope when the change declares no path", () => {
		const at = fixture({command: "true", changed: []});
		writeFileSync(join(at.dir, "changed.txt"), "");
		const run = gate(at.args);
		expect(run.code).toBe(ZERO_SCOPE);
		expect(run.stderr).toContain("zero-scope");
	});
});

/**
 * The dispatcher, in `sh` for `post.cli.test.ts`'s reason: an extensionless entry file's module
 * system is a platform detail this test has no business depending on.
 */
const SHIM = `#!/bin/sh
case "$*" in
  *"pulls/9041/files"*) cat "$GH_STATE/files.json" ;;
  *"pulls/9041"*) cat "$GH_STATE/pull.json" ;;
  *"issues/9041/comments"*) cat "$GH_STATE/comments.json" ;;
  *) echo "unscripted: $*" >&2; exit 1 ;;
esac
`;

describe("fabrika eval gate, over a pull request", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("resolves head, changed paths and records off the platform, and merges green on the debt", () => {
		const at = fixture({command: "true", changed: []});
		const shimDir = mkdtempSync(join(tmpdir(), "fabrika-gate-shim-"));
		const state = join(shimDir, "state");
		mkdirSync(state, {recursive: true});
		writeFileSync(join(shimDir, "gh"), SHIM);
		chmodSync(join(shimDir, "gh"), 0o755);
		writeFileSync(
			join(state, "pull.json"),
			JSON.stringify({
				number: 9041,
				state: "open",
				head: {sha: HEAD},
				base: {ref: "main"},
				body: "",
				changed_files: 1,
				comments: 0,
			}),
		);
		writeFileSync(join(state, "files.json"), JSON.stringify([{filename: SKILL_PATH}]));
		writeFileSync(join(state, "comments.json"), JSON.stringify([]));

		const run = gate(
			[
				"9041",
				"--floor-cases",
				join(at.dir, "evals.json"),
				"--floor-commands",
				join(at.dir, "commands.json"),
				"--series-dir",
				join(at.dir, "series"),
				"--spend-ledger",
				join(at.dir, "no-such-ledger.jsonl"),
			],
			{PATH: `${shimDir}:${process.env.PATH ?? ""}`, GH_STATE: state},
		);
		expect(run.code).toBe(0);
		expect(run.stderr).toContain(`o/r#9041 at ${HEAD}`);
		expect(run.stderr).toContain("1 changed path(s)");
		expect(run.stdout).toContain("graded: REPORTED, NOT ENFORCED");
	});
});
