import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	type CliObservation,
	checkAssertion,
	type DeterministicCommand,
	judgeDeterministicCase,
	namedArtifactPaths,
	readExpectation,
	reconcileRerun,
	runDeterministicTier,
	summarizeEvalRows,
	type TieredEvalCase,
} from "./deterministic-tier.ts";

const ran = (over: Partial<CliObservation> = {}): CliObservation => ({
	exitStatus: 0,
	stdout: "",
	stderr: "",
	artifacts: [],
	toolInvocations: null,
	notRun: null,
	...over,
});

/** The observation seam as the `Effect` the tier takes. Nothing here does IO — it is a value. */
const saw = (over: Partial<CliObservation> = {}): Effect.Effect<CliObservation> =>
	Effect.succeed(ran(over));

const mechanical = (text: string, cue: string) => ({kind: "mechanical", text, cue}) as const;

const deterministicCase = (
	id: number,
	assertions: TieredEvalCase["assertions"],
): TieredEvalCase => ({
	id,
	tier: "deterministic",
	assertions,
});

const gradedCase = (id: number): TieredEvalCase => ({
	id,
	tier: "graded",
	assertions: [{kind: "judgment", text: "the answer reads well"}],
});

const command: DeterministicCommand = {command: "true", args: [], cwd: null, timeoutMs: null};

const resolveCommand = () => command;

describe("readExpectation — literal, and unreadable rather than guessed", () => {
	it("reads an expected exit code", () => {
		assert.deepStrictEqual(readExpectation(mechanical("exits 0", "exit-status")), {
			_tag: "ExitStatus",
			code: 0,
		});
		assert.deepStrictEqual(readExpectation(mechanical("exit code is 3", "exit-status")), {
			_tag: "ExitStatus",
			code: 3,
		});
	});

	it("reads a non-zero exit expectation", () => {
		assert.deepStrictEqual(readExpectation(mechanical("exits non-zero", "exit-status")), {
			_tag: "ExitNonZero",
		});
	});

	it("reads the stream and needle of an output-content assertion", () => {
		assert.deepStrictEqual(
			readExpectation(mechanical("stderr contains 'refusing to push'", "output-content")),
			{_tag: "Substring", stream: "stderr", needle: "refusing to push"},
		);
		assert.deepStrictEqual(
			readExpectation(mechanical("output includes `PASS`", "output-content")),
			{_tag: "Substring", stream: "any", needle: "PASS"},
		);
	});

	it("reads a quoted file path and a quoted tool", () => {
		assert.deepStrictEqual(
			readExpectation(mechanical("a file named `out/report.json` exists", "file-artifact")),
			{_tag: "FileExists", path: "out/report.json"},
		);
		assert.deepStrictEqual(
			readExpectation(mechanical("uses script `verified-push`", "tool-invocation")),
			{_tag: "ToolInvoked", tool: "verified-push"},
		);
	});

	it("is unreadable — never a guess — when the prose names no concrete expectation", () => {
		for (const assertion of [
			mechanical("the exit status looks right", "exit-status"),
			mechanical("output contains the summary", "output-content"),
			mechanical("a file exists somewhere", "file-artifact"),
			mechanical("it ran the script", "tool-invocation"),
			mechanical("exits 0", "some-future-cue"),
		]) {
			assert.strictEqual(readExpectation(assertion)._tag, "Unreadable");
		}
	});

	it("routes a judgment assertion away rather than pretending to check it", () => {
		const expectation = readExpectation({kind: "judgment", text: "the tone is right"});
		assert.strictEqual(expectation._tag, "Unreadable");
	});

	it("collects the artifact paths an observer must probe for", () => {
		const evalCase = deterministicCase(1, [
			mechanical("a file named `a.txt` exists", "file-artifact"),
			mechanical("exits 0", "exit-status"),
			mechanical("creates a file `b/c.json`", "file-artifact"),
		]);
		assert.deepStrictEqual(namedArtifactPaths(evalCase), ["a.txt", "b/c.json"]);
	});
});

describe("checkAssertion — total, and never a silent skip", () => {
	it("passes and fails an exit-status assertion on the observed status", () => {
		const assertion = mechanical("exits 0", "exit-status");
		assert.strictEqual(checkAssertion(assertion, ran()).status, "pass");
		const failed = checkAssertion(assertion, ran({exitStatus: 1}));
		assert.strictEqual(failed.status, "fail");
		assert.strictEqual(failed.detail, "exit status was 1, expected 0");
	});

	it("fails — does not skip — a run killed before it reported a status", () => {
		const outcome = checkAssertion(mechanical("exits 0", "exit-status"), ran({exitStatus: null}));
		assert.strictEqual(outcome.status, "fail");
	});

	it("checks output content against the named stream only", () => {
		const observation = ran({stdout: "hello", stderr: "boom"});
		assert.strictEqual(
			checkAssertion(mechanical("stdout contains 'hello'", "output-content"), observation).status,
			"pass",
		);
		assert.strictEqual(
			checkAssertion(mechanical("stdout contains 'boom'", "output-content"), observation).status,
			"fail",
		);
		assert.strictEqual(
			checkAssertion(mechanical("output contains 'boom'", "output-content"), observation).status,
			"pass",
		);
	});

	it("checks a named file against what the observer found", () => {
		const assertion = mechanical("a file named `out.json` exists", "file-artifact");
		assert.strictEqual(checkAssertion(assertion, ran({artifacts: ["out.json"]})).status, "pass");
		assert.strictEqual(checkAssertion(assertion, ran()).status, "fail");
	});

	it("is uncheckable — not a fail — when the observer cannot see tool invocations at all", () => {
		const assertion = mechanical("used script `push`", "tool-invocation");
		assert.strictEqual(checkAssertion(assertion, ran()).status, "uncheckable");
		assert.strictEqual(checkAssertion(assertion, ran({toolInvocations: ["push"]})).status, "pass");
		assert.strictEqual(checkAssertion(assertion, ran({toolInvocations: []})).status, "fail");
	});
});

describe("judgeDeterministicCase — the whole verdict, from exactly one run", () => {
	it("passes a case whose every assertion holds, in one run", () => {
		const row = judgeDeterministicCase(
			deterministicCase(1, [
				mechanical("exits 0", "exit-status"),
				mechanical("stdout contains 'ok'", "output-content"),
			]),
			ran({stdout: "ok"}),
		);
		assert.strictEqual(row.outcome, "pass");
		assert.strictEqual(row.runs, 1);
		assert.strictEqual(row.detail, null);
	});

	it("fails a case with a failing assertion and names why", () => {
		const row = judgeDeterministicCase(
			deterministicCase(2, [mechanical("exits 0", "exit-status")]),
			ran({exitStatus: 2}),
		);
		assert.strictEqual(row.outcome, "fail");
		assert.strictEqual(row.detail, "exit status was 2, expected 0");
	});

	it("reds an uncheckable assertion ahead of a merely failing one", () => {
		const row = judgeDeterministicCase(
			deterministicCase(3, [
				mechanical("exits 0", "exit-status"),
				mechanical("output contains the right thing", "output-content"),
			]),
			ran({exitStatus: 9}),
		);
		assert.strictEqual(row.outcome, "uncheckable");
	});

	it("reds a case with no assertions rather than passing it vacuously", () => {
		const row = judgeDeterministicCase(deterministicCase(4, []), ran());
		assert.strictEqual(row.outcome, "uncheckable");
	});

	it("reads a did-not-run as UNKNOWN, never as a failing assertion (§ZS)", () => {
		const row = judgeDeterministicCase(
			deterministicCase(5, [mechanical("exits non-zero", "exit-status")]),
			ran({exitStatus: null, notRun: "spawn nope ENOENT"}),
		);
		assert.strictEqual(row.outcome, "uncheckable");
		assert.include(row.detail ?? "", "never ran");
	});
});

describe("runDeterministicTier — routing, with no model in the loop", () => {
	it("routes each case by its derived tier", () => {
		const run = Effect.runSync(
			runDeterministicTier({
				cases: [deterministicCase(1, [mechanical("exits 0", "exit-status")]), gradedCase(2)],
				resolveCommand,
				observe: () => saw(),
			}),
		);
		assert.deepStrictEqual(
			run.rows.map((r) => r.caseId),
			[1],
		);
		assert.deepStrictEqual(run.deferredToGraded, [2]);
	});

	it("never reaches the model-bearing seam for a deterministic case", () => {
		const run = Effect.runSync(
			runDeterministicTier({
				cases: [
					deterministicCase(1, [mechanical("exits 0", "exit-status")]),
					deterministicCase(2, [mechanical("exits non-zero", "exit-status")]),
				],
				resolveCommand,
				observe: () => saw(),
				deferGraded: () => {
					throw new Error("a model was spawned for a deterministic case");
				},
			}),
		);
		assert.strictEqual(run.rows.length, 2);
		assert.deepStrictEqual(run.deferredToGraded, []);
	});

	it("hands a graded case to that seam instead of executing it", () => {
		const handed: Array<number> = [];
		const observed: Array<number> = [];
		Effect.runSync(
			runDeterministicTier({
				cases: [gradedCase(7)],
				resolveCommand,
				observe: (evalCase) => {
					observed.push(evalCase.id);
					return saw();
				},
				deferGraded: (evalCase) => handed.push(evalCase.id),
			}),
		);
		assert.deepStrictEqual(handed, [7]);
		assert.deepStrictEqual(observed, []);
	});

	it("executes each deterministic case exactly once", () => {
		const executions: Array<number> = [];
		Effect.runSync(
			runDeterministicTier({
				cases: [
					deterministicCase(1, [mechanical("exits 0", "exit-status")]),
					deterministicCase(2, [mechanical("exits 0", "exit-status")]),
				],
				resolveCommand,
				observe: (evalCase) => {
					executions.push(evalCase.id);
					return saw({exitStatus: 1});
				},
			}),
		);
		assert.deepStrictEqual(executions, [1, 2]);
	});

	it("reds a case that declares no command instead of skipping it", () => {
		const run = Effect.runSync(
			runDeterministicTier({
				cases: [deterministicCase(1, [mechanical("exits 0", "exit-status")])],
				resolveCommand: () => null,
				observe: () => saw(),
			}),
		);
		assert.strictEqual(run.rows[0]?.outcome, "uncheckable");
		assert.strictEqual(run.rows[0]?.runs, 0);
	});

	// AC1's "no model invocation, verifiable by the absence of any spawn" is a property of the
	// module, not of one code path: a behavioral test can only prove the paths it exercises. The
	// tier can reach nothing spawnable if it imports nothing spawnable, and that is readable.
	it("imports no runtime or observer module that could spawn anything", () => {
		const source = readFileSync(
			fileURLToPath(new URL("./deterministic-tier.ts", import.meta.url)),
			"utf8",
		);
		const specifiers = [...source.matchAll(/^import\s[\s\S]*?from\s"([^"]+)";$/gm)].map(
			(m) => m[1] ?? "",
		);
		assert.deepStrictEqual(
			specifiers.filter((s) => s.startsWith("node:") || s.includes("observer")),
			[],
		);
	});
});

describe("reconcileRerun — a flake is surfaced, never retried into green", () => {
	const failing = judgeDeterministicCase(
		deterministicCase(1, [mechanical("exits 0", "exit-status")]),
		ran({exitStatus: 1}),
	);
	const passing = judgeDeterministicCase(
		deterministicCase(1, [mechanical("exits 0", "exit-status")]),
		ran(),
	);

	it("leaves an agreeing re-run's verdict at the first run's, still one run", () => {
		const {row, defect} = reconcileRerun(failing, failing);
		assert.strictEqual(row.outcome, "fail");
		assert.strictEqual(row.runs, 1);
		assert.strictEqual(defect, null);
	});

	it("cannot turn a fail into a pass — a disagreeing re-run is a flake, not a win", () => {
		const {row, defect} = reconcileRerun(failing, passing);
		assert.strictEqual(row.outcome, "flake");
		assert.strictEqual(row.runs, 2);
		assert.strictEqual(defect?.firstOutcome, "fail");
		assert.strictEqual(defect?.rerunOutcome, "pass");
		assert.include(defect?.summary ?? "", "did not reproduce");
	});

	it("surfaces the reverse direction too — a pass that later fails is the same defect", () => {
		const {row, defect} = reconcileRerun(passing, failing);
		assert.strictEqual(row.outcome, "flake");
		assert.notStrictEqual(defect, null);
	});

	it("makes the suite red on a flake", () => {
		const {row} = reconcileRerun(failing, passing);
		const summary = summarizeEvalRows([row]);
		assert.strictEqual(summary.verdict, "red");
		assert.strictEqual(summary.total.flaked, 1);
	});
});

describe("summarizeEvalRows — one aggregation path for both tiers", () => {
	const row = (caseId: number, tier: "deterministic" | "graded", outcome: "pass" | "fail") => ({
		caseId,
		tier,
		outcome,
		runs: tier === "deterministic" ? 1 : 5,
		assertions: [],
		detail: outcome === "pass" ? null : "nope",
	});

	it("folds deterministic and graded rows through the same function", () => {
		const summary = summarizeEvalRows([
			row(1, "deterministic", "pass"),
			row(2, "deterministic", "fail"),
			row(3, "graded", "pass"),
		]);
		assert.strictEqual(summary.total.cases, 3);
		assert.strictEqual(summary.byTier.deterministic.cases, 2);
		assert.strictEqual(summary.byTier.graded.cases, 1);
		assert.strictEqual(summary.passRate, 2 / 3);
		assert.strictEqual(summary.verdict, "red");
	});

	it("is green only when every row passed", () => {
		const summary = summarizeEvalRows([row(1, "deterministic", "pass")]);
		assert.strictEqual(summary.verdict, "green");
		assert.strictEqual(summary.redReason, null);
	});

	it("reds on zero scope rather than passing an empty suite (ADR 0092)", () => {
		const summary = summarizeEvalRows([]);
		assert.strictEqual(summary.verdict, "red");
		assert.include(summary.redReason ?? "", "zero scope");
		assert.strictEqual(summary.passRate, 0);
	});
});
