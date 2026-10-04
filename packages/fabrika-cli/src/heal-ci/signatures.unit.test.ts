import {describe, expect, it} from "vitest";
import {inputFromEnv, JOBS_ENV_KEY, judge} from "../ci/required.ts";
import {CI_REQUIRED_ROLLUP_LOG} from "./fixtures.test-support.ts";
import {classifyLog, SIGNATURES} from "./signatures.ts";

/** One fixture per row, so the table is exercised by its own contract rather than by a sample. */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
	["runner-oom", "##[error]The operation was terminated: exit code 137"],
	["runner-cancelled-infra", "The runner has received a shutdown signal."],
	["rate-limited", "API rate limit exceeded for installation."],
	["preview-warmup", "preview at https://x.workers.dev did not become reachable after 60s"],
	["readiness-stall", "readiness probe timed out after 120s"],
	["network-transient", "Error: connect ETIMEDOUT registry.npmjs.org:443"],
	["assertion-failure", "AssertionError: expected 3 to be 2"],
	["typecheck-failure", "src/a.ts(3,1): error TS2345: Argument of type 'x'."],
	["lint-failure", "biome check found 1 error in src/a.ts"],
	["build-failure", "Error: Cannot find module './missing'"],
	["roll-up-verdict", "##[error]unit: should_run=true result=failure → FAIL (silent no-op)"],
];

describe("the taxonomy is a table, and every row is reachable", () => {
	it("ships exactly the eleven contracted rows in order", () => {
		expect(SIGNATURES.map((row) => row.id)).toEqual(FIXTURES.map(([id]) => id));
	});

	it.each(FIXTURES)("`%s` matches its own fixture", (id, line) => {
		const found = classifyLog(line);
		expect(found._tag).toBe("Matched");
		expect(found._tag === "Matched" ? found.signature.id : null).toBe(id);
	});

	it("puts every transient row above every logic row, and the derived row below both", () => {
		const rank = {transient: 0, logic: 1, derived: 2};
		const ranks = SIGNATURES.map((row) => rank[row.class]);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(SIGNATURES.at(-1)?.class).toBe("derived");
	});
});

describe("a roll-up that only restates another job's verdict is derived", () => {
	it("classifies a ci-required log holding only verdict prose as derived", () => {
		const found = classifyLog(CI_REQUIRED_ROLLUP_LOG);
		expect(found._tag === "Matched" ? found.signature : null).toMatchObject({
			id: "roll-up-verdict",
			class: "derived",
		});
		expect(found._tag === "Matched" ? found.line : null).toBe(2);
	});

	it("classifies a log carrying a real defect beside roll-up prose on the defect", () => {
		const found = classifyLog(
			[CI_REQUIRED_ROLLUP_LOG, "AssertionError: expected 3 to be 2"].join("\n"),
		);
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("assertion-failure");
	});

	it.each([
		["a should-have-run job that failed", "success", {required: true, result: "failure"}],
		["a should-have-run job that never ran", "success", {required: true, result: "skipped"}],
		["a not-required job that was cancelled", "success", {required: false, result: "cancelled"}],
		["a failed required-ness source", "failure", {required: false, result: "skipped"}],
	] as const)("matches the line the gate prints for %s", (_case, changesResult, job) => {
		const verdict = judge({changesResult, jobs: [{name: "unit", ...job}], scopeReasons: []});
		const failing = [verdict.changesReport, ...verdict.jobs].filter(
			(report) => report?.verdict === "FAIL",
		);
		expect(failing).toHaveLength(1);
		const found = classifyLog(failing[0]?.reason ?? "");
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("roll-up-verdict");
	});

	it.each([
		["names no gating job", {CHANGES_RESULT: "success"}],
		[
			"declares a job whose required-ness key is absent",
			{CHANGES_RESULT: "success", [JOBS_ENV_KEY]: "unit", UNIT_RESULT: "success"},
		],
	])("leaves a roll-up that failed on its own scope read unclassified when it %s", (_case, env) => {
		const verdict = judge(inputFromEnv(env));
		expect(verdict.pass).toBe(false);
		expect(verdict.scopeReasons).not.toHaveLength(0);
		expect([verdict.changesReport, ...verdict.jobs].some((r) => r?.verdict === "FAIL")).toBe(false);
		// The lines `ci/required-bin.ts` prints for this verdict, as the runner renders them.
		const log = [
			...verdict.scopeReasons.map((reason) => `##[error]ci-required: ${reason}`),
			...verdict.jobs.map((job) => job.reason),
			"##[error]ci-required FAILED — a should-have-run gating job was skipped or failed (see per-job verdicts above)",
			"##[error]Process completed with exit code 1.",
		].join("\n");
		expect(classifyLog(log)._tag).toBe("Unclassified");
	});
});

describe("precedence is the table's, not the log's", () => {
	it("reads an OOM-killed suite as the infrastructure death it is, not the assertion it printed", () => {
		const found = classifyLog(
			["AssertionError: expected 3 to be 2", "##[error]exit code 137"].join("\n"),
		);
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("runner-oom");
	});

	it("reads a preview target answering 502 as a warmup, not as generic network trouble", () => {
		const found = classifyLog("deployment target returned 502 Bad Gateway");
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("preview-warmup");
	});

	it("reports the matched line 1-based within the block", () => {
		const found = classifyLog(["a", "b", "AssertionError: boom"].join("\n"));
		expect(found._tag === "Matched" ? found.line : null).toBe(3);
	});
});

describe("default-deny", () => {
	it("recognises nothing rather than guessing transient", () => {
		const found = classifyLog("Something went wrong.");
		expect(found._tag).toBe("Unclassified");
	});

	it("leaves a committed-secret finding unclassified, so it reaches a person and never a repair lane", () => {
		const found = classifyLog(
			[
				"5:32AM INF 2 commits scanned.",
				"5:32AM WRN leaks found: 1",
				"##[error]gitleaks found a secret in a file this PR adds or edits. Remove it at HEAD, rotate it, and (if a real credential) treat the leak as an incident — do NOT allowlist a real secret.",
				"##[error]Process completed with exit code 1.",
			].join("\n"),
		);
		expect(found._tag).toBe("Unclassified");
	});
});
