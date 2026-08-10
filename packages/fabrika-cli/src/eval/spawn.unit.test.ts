/**
 * Unit tier for the spawn-and-collect core (#4676). No model call and no subprocess: the executor
 * is a stub, which is the seam the design exists to expose.
 *
 * The silent-green fixtures below are **captured output**, not invented shapes — the payload in
 * `SILENT_GREEN_STDOUT` is what `claude -p "/definitely-not-a-skill…" --output-format json` actually
 * returned on 2.1.220 while building this. If a future CLI stops behaving that way these tests go
 * green for the wrong reason, so they are paired with the argv contract tests, which pin the flags
 * that produce it.
 */
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Result} from "effect";
import {MODEL_ALIASES} from "../models.ts";
import {classifyRunSpend} from "../spend/token-spend.ts";
import type {CorpusManifest} from "./corpus.ts";
import {collectFromCapture, decodeCaptureManifest} from "./runner.ts";
import {
	buildClaudeArgs,
	buildLedger,
	captureToJson,
	classifyRun,
	decodeHeadlessResult,
	type EvalArm,
	type Executor,
	type ExecutorResult,
	executeRuns,
	isStageName,
	type PlannedRun,
	parseArms,
	planEvalRuns,
	type RunnableCase,
	type RunOutcome,
	renderLedger,
	suiteExecuted,
	summarizeRuns,
	toCaptureManifest,
	totalSpend,
} from "./spawn.ts";

const CASES: ReadonlyArray<RunnableCase> = [
	{id: 1, prompt: "/probe alpha", tier: "graded"},
	{id: 2, prompt: "/probe beta", tier: "deterministic"},
];

const BOTH_ARMS: ReadonlyArray<EvalArm> = ["with-skill", "without-skill"];

const plan = (over: Partial<PlannedRun> = {}): PlannedRun => ({
	caseId: 1,
	tier: "graded",
	arm: "with-skill",
	sessionId: "11111111-2222-4333-8444-555555555555",
	prompt: "/probe alpha",
	model: "sonnet",
	pluginDir: "/candidate/plugin",
	jsonSchema: null,
	...over,
});

/** A well-formed result message: the array-of-stream-messages form the CLI actually emits. */
const resultStdout = (over: Record<string, unknown> = {}): string =>
	JSON.stringify([
		{type: "system", subtype: "init", session_id: "s"},
		{type: "assistant", message: {role: "assistant"}},
		{
			type: "result",
			subtype: "success",
			is_error: false,
			num_turns: 3,
			result: "done",
			session_id: "11111111-2222-4333-8444-555555555555",
			total_cost_usd: 0.19,
			modelUsage: {"claude-sonnet-5": {costUSD: 0.19}},
			...over,
		},
	]);

/** Captured verbatim: the unresolvable-skill run that exits 0 and reports success (#4673 §6). */
const SILENT_GREEN_STDOUT = JSON.stringify([
	{type: "system", subtype: "init", session_id: "s"},
	{type: "assistant", message: {role: "assistant"}},
	{
		type: "result",
		subtype: "success",
		is_error: false,
		num_turns: 0,
		result: "Unknown command: /definitely-not-a-skill-4676-probe",
		session_id: "11111111-2222-4333-8444-555555555555",
		total_cost_usd: 0,
		modelUsage: {},
	},
]);

const exited = (stdout: string, code = 0): ExecutorResult => ({
	_tag: "Exited",
	code,
	stdout,
	stderr: "",
});

const billedTranscript = JSON.stringify({
	message: {
		role: "assistant",
		model: "claude-sonnet-5",
		usage: {
			input_tokens: 2,
			cache_creation_input_tokens: 32_122,
			cache_read_input_tokens: 0,
			output_tokens: 19,
		},
	},
});

/** Parses cleanly, carries no assistant turn: the well-formed zero `NoBilledTurns` exists to name. */
const NO_BILLED_TRANSCRIPT = '{"type":"summary"}';

const completedRun = (over: Partial<Parameters<typeof classifyRun>[0]> = {}): RunOutcome =>
	classifyRun({
		plan: plan(),
		exec: exited(resultStdout()),
		transcriptPath: "/data/projects/x/s.jsonl",
		spend: classifyRunSpend(billedTranscript),
		...over,
	});

describe("planEvalRuns — one invocation per (case × arm)", () => {
	it("plans every case on every requested arm", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: CASES,
				arms: BOTH_ARMS,
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id, arm) => Effect.succeed(`${id}-${arm}`),
			}),
		);
		assert.strictEqual(plans.length, 4);
		assert.deepStrictEqual(
			plans.map((p) => `${p.caseId}:${p.arm}`),
			["1:with-skill", "1:without-skill", "2:with-skill", "2:without-skill"],
		);
	});

	it("the arm variable is skill availability: with-skill carries the plugin dir, without-skill carries none", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: [CASES[0] as RunnableCase],
				arms: BOTH_ARMS,
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id, arm) => Effect.succeed(`${id}-${arm}`),
			}),
		);
		assert.strictEqual(plans[0]?.pluginDir, "/candidate");
		assert.strictEqual(plans[1]?.pluginDir, null);
	});

	it("carries each case's derived tier through, so a downstream tier verb needn't re-read the set", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: CASES,
				arms: ["with-skill"],
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id) => Effect.succeed(`${id}`),
			}),
		);
		assert.deepStrictEqual(
			plans.map((p) => p.tier),
			["graded", "deterministic"],
		);
	});
});

/**
 * #5158 (ruled option B on #5148): `--model` is normalized to one canonical spelling before it
 * reaches a plan, and is normalized ONLY — an unknown value still runs. The alias pair is read from
 * fabrika's one table rather than typed, so a test can never become a second source.
 */
describe("planEvalRuns — the model a run is pinned to is canonicalized, never allowlisted", () => {
	const aliasEntry = Object.entries(MODEL_ALIASES)[0];
	if (aliasEntry === undefined) {
		throw new Error("MODEL_ALIASES declares no alias — there is nothing for a run to normalize");
	}
	const [aliasedModel, canonicalId] = aliasEntry;

	const plansFor = (model: string) =>
		Effect.runSync(
			planEvalRuns({
				cases: [CASES[0] as RunnableCase],
				arms: ["with-skill"],
				model,
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id) => Effect.succeed(`${id}`),
			}),
		);

	it("an alias reaches the plan — and the argv — as its canonical id", () => {
		const planned = plansFor(aliasedModel);
		assert.strictEqual(planned[0]?.model, canonicalId);
		assert.include([...buildClaudeArgs(planned[0] as PlannedRun)], canonicalId);
	});

	it("a model the table has never seen is planned exactly as given", () => {
		const unknown = "a-model-the-table-has-never-seen";
		assert.strictEqual(plansFor(unknown)[0]?.model, unknown);
	});

	it("the ledger and its capture manifest record the canonical spelling too", () => {
		const outcomes = Effect.runSync(
			executeRuns({
				plans: plansFor(aliasedModel),
				executor: () => Effect.succeed(exited(resultStdout())),
				locateTranscript: (sessionId) => Effect.succeed(`/data/${sessionId}.jsonl`),
				loadTranscript: () => Effect.succeed(billedTranscript),
			}),
		);
		const ledger = buildLedger({
			skillName: "probe",
			stage: "triage",
			model: aliasedModel,
			cliVersion: "2.1.220",
			recordedAt: "2026-08-09T00:00:00Z",
			outcomes,
		});
		assert.strictEqual(ledger.model, canonicalId);
		assert.strictEqual(ledger.capture.runs[0]?.model, canonicalId);
		assert.strictEqual(ledger.spendRows[0]?.model, canonicalId);
	});
});

describe("buildClaudeArgs — the measured invocation contract (#4673 §1)", () => {
	it("pins the session id, the output format and the model, and passes the prompt to -p", () => {
		assert.deepStrictEqual(
			[...buildClaudeArgs(plan({pluginDir: null}))],
			[
				"-p",
				"/probe alpha",
				"--output-format",
				"json",
				"--session-id",
				"11111111-2222-4333-8444-555555555555",
				"--model",
				"sonnet",
			],
		);
	});

	it("the two arms' argv differ by exactly --plugin-dir", () => {
		const withSkill = [...buildClaudeArgs(plan({arm: "with-skill", pluginDir: "/candidate"}))];
		const without = [...buildClaudeArgs(plan({arm: "without-skill", pluginDir: null}))];
		assert.deepStrictEqual(
			withSkill.filter((a) => !["--plugin-dir", "/candidate"].includes(a)),
			without,
		);
	});

	it("requests the decision artifact via --json-schema when one was asked for", () => {
		const args = [...buildClaudeArgs(plan({jsonSchema: '{"type":"object"}'}))];
		assert.include(args, "--json-schema");
		assert.include(args, '{"type":"object"}');
	});

	it("never emits --no-session-persistence (it would suppress the transcript) or --disable-slash-commands (it short-circuits a /skill prompt)", () => {
		for (const p of [plan(), plan({pluginDir: null}), plan({jsonSchema: "{}"})]) {
			const args = [...buildClaudeArgs(p)];
			assert.notInclude(args, "--no-session-persistence");
			assert.notInclude(args, "--disable-slash-commands");
		}
	});
});

describe("decodeHeadlessResult — tolerant of both observed stdout shapes", () => {
	it("reads the result message out of the stream array the CLI emits", () => {
		const decoded = decodeHeadlessResult(resultStdout());
		assert.strictEqual(decoded?.numTurns, 3);
		assert.deepStrictEqual(decoded?.modelUsageKeys, ["claude-sonnet-5"]);
		assert.strictEqual(decoded?.totalCostUsd, 0.19);
	});

	it("reads a bare result object too", () => {
		const decoded = decodeHeadlessResult(
			JSON.stringify({type: "result", is_error: false, num_turns: 2, modelUsage: {m: {}}}),
		);
		assert.strictEqual(decoded?.numTurns, 2);
	});

	it("a non-JSON body and a stream with no result message both decode to null, never to a pass", () => {
		assert.strictEqual(decodeHeadlessResult("not json at all"), null);
		assert.strictEqual(decodeHeadlessResult(JSON.stringify([{type: "system"}])), null);
	});

	it("a missing field degrades toward stricter, never toward a pass", () => {
		const decoded = decodeHeadlessResult(JSON.stringify({type: "result"}));
		assert.strictEqual(decoded?.numTurns, 0);
		assert.deepStrictEqual(decoded?.modelUsageKeys, []);
		assert.strictEqual(decoded?.hasStructuredOutput, false);
	});

	it("captures structured_output as the artifact when the run produced one", () => {
		const decoded = decodeHeadlessResult(
			resultStdout({structured_output: {verdict: "ok", token: "T"}}),
		);
		assert.deepStrictEqual(decoded?.structuredOutput, {verdict: "ok", token: "T"});
	});
});

describe("classifyRun — the synthesized failure signal for a silent green (#4673 §6)", () => {
	it("the captured unresolvable-skill run is a typed failure, not a free pass", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(SILENT_GREEN_STDOUT, 0),
			transcriptPath: "/data/projects/x/s.jsonl",
			spend: classifyRunSpend(NO_BILLED_TRANSCRIPT),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed") return;
		assert.strictEqual(outcome.failure._tag, "NoModelTurns");
		if (outcome.failure._tag !== "NoModelTurns") return;
		assert.strictEqual(outcome.failure.signal, "unknown-command");
	});

	it("num_turns: 0 alone is enough — a run that never reached a model cannot be collected", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(resultStdout({num_turns: 0, result: "ok"})),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Failed");
	});

	it("an empty modelUsage is its own signal", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(resultStdout({modelUsage: {}})),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed" || outcome.failure._tag !== "NoModelTurns") return;
		assert.strictEqual(outcome.failure.signal, "empty-model-usage");
	});

	it("a transcript that reconstructs to zero billed turns is a failure even when the result looks healthy", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(resultStdout()),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(NO_BILLED_TRANSCRIPT),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed" || outcome.failure._tag !== "NoModelTurns") return;
		assert.strictEqual(outcome.failure.signal, "zero-assistant-turns");
	});

	it("a requested --json-schema that produced no structured_output is a failure", () => {
		const outcome = classifyRun({
			plan: plan({jsonSchema: '{"type":"object"}'}),
			exec: exited(resultStdout()),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed" || outcome.failure._tag !== "NoModelTurns") return;
		assert.strictEqual(outcome.failure.signal, "missing-structured-output");
	});

	it("the same run WITH a structured_output completes and carries it as the artifact", () => {
		const outcome = classifyRun({
			plan: plan({jsonSchema: '{"type":"object"}'}),
			exec: exited(resultStdout({structured_output: {verdict: "ok"}})),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Completed");
		if (outcome._tag !== "Completed") return;
		assert.deepStrictEqual(outcome.artifact, {verdict: "ok"});
	});
});

describe("classifyRun — a dying run is a typed counted outcome, never a crash", () => {
	it("a spawn that never started", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: {_tag: "SpawnFailed", detail: "ENOENT: claude not found"},
			transcriptPath: null,
			spend: classifyRunSpend(null),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed") return;
		assert.strictEqual(outcome.failure._tag, "SpawnFailed");
	});

	it("a run past its stated bound", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: {_tag: "TimedOut", boundMs: 900_000},
			transcriptPath: null,
			spend: classifyRunSpend(null),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed" || outcome.failure._tag !== "TimedOut") return;
		assert.strictEqual(outcome.failure.boundMs, 900_000);
	});

	it("stdout that carries no readable result message", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited("<html>gateway error</html>", 1),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed") return;
		assert.strictEqual(outcome.failure._tag, "UndecodableResult");
	});

	it("a run the CLI itself flags as an error", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(resultStdout({is_error: true, subtype: "error_during_execution"})),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed") return;
		assert.strictEqual(outcome.failure._tag, "ReportedError");
	});

	it("a healthy run whose transcript cannot be found", () => {
		const outcome = classifyRun({
			plan: plan(),
			exec: exited(resultStdout()),
			transcriptPath: null,
			spend: classifyRunSpend(null),
		});
		assert.strictEqual(outcome._tag, "Failed");
		if (outcome._tag !== "Failed") return;
		assert.strictEqual(outcome.failure._tag, "TranscriptNotFound");
	});
});

describe("executeRuns — the suite completes, against a stubbed executor", () => {
	const stub =
		(byArm: Readonly<Record<EvalArm, ExecutorResult>>): Executor =>
		(p) =>
			Effect.succeed(byArm[p.arm] as ExecutorResult);

	it("one dead arm does not abort the suite; every planned run is accounted for", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: CASES,
				arms: BOTH_ARMS,
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id, arm) => Effect.succeed(`${id}-${arm}`),
			}),
		);
		const outcomes = Effect.runSync(
			executeRuns({
				plans,
				executor: stub({
					"with-skill": exited(SILENT_GREEN_STDOUT),
					"without-skill": exited(resultStdout()),
				}),
				locateTranscript: (sessionId) => Effect.succeed(`/data/${sessionId}.jsonl`),
				loadTranscript: () => Effect.succeed(billedTranscript),
			}),
		);
		assert.strictEqual(outcomes.length, 4);
		const summary = summarizeRuns(outcomes);
		assert.strictEqual(summary.planned, 4);
		assert.strictEqual(summary.completed, 2);
		assert.strictEqual(summary.failed, 2);
		assert.strictEqual(summary.byFailure["NoModelTurns:unknown-command"], 2);
	});

	it("both arms stay distinguishable in the collected output", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: [CASES[0] as RunnableCase],
				arms: BOTH_ARMS,
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id, arm) => Effect.succeed(`${id}-${arm}`),
			}),
		);
		const outcomes = Effect.runSync(
			executeRuns({
				plans,
				executor: () => Effect.succeed(exited(resultStdout())),
				locateTranscript: (sessionId) => Effect.succeed(`/data/${sessionId}.jsonl`),
				loadTranscript: () => Effect.succeed(billedTranscript),
			}),
		);
		assert.deepStrictEqual(
			outcomes.map((o) => o.arm),
			["with-skill", "without-skill"],
		);
		const ledger = buildLedger({
			skillName: "probe",
			stage: "triage",
			model: "sonnet",
			cliVersion: "2.1.220",
			recordedAt: "2026-08-09T00:00:00Z",
			outcomes,
		});
		assert.strictEqual(ledger.summary.byArm["with-skill"].completed, 1);
		assert.strictEqual(ledger.summary.byArm["without-skill"].completed, 1);
	});

	it("a transcript the loader cannot read yields TranscriptNotFound, not a fabricated zero", () => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: [CASES[0] as RunnableCase],
				arms: ["with-skill"],
				model: "sonnet",
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: () => Effect.succeed("s"),
			}),
		);
		const outcomes = Effect.runSync(
			executeRuns({
				plans,
				executor: () => Effect.succeed(exited(resultStdout())),
				locateTranscript: () => Effect.succeed(null),
				loadTranscript: () => Effect.succeed(null),
			}),
		);
		assert.strictEqual(outcomes[0]?._tag, "Failed");
	});
});

describe("toCaptureManifest — the existing collector consumes it unchanged", () => {
	it("only collectable runs enter the manifest; a failed run is never handed to the oracle", () => {
		const outcomes: ReadonlyArray<RunOutcome> = [
			completedRun(),
			classifyRun({
				plan: plan({caseId: 2}),
				exec: exited(SILENT_GREEN_STDOUT),
				transcriptPath: "/t.jsonl",
				spend: classifyRunSpend(NO_BILLED_TRANSCRIPT),
			}),
		];
		const capture = toCaptureManifest({stage: "triage", model: "sonnet", outcomes});
		assert.strictEqual(capture.runs.length, 1);
		assert.strictEqual(capture.runs[0]?.inputRef, 1);
	});

	it("what it writes round-trips through the existing decodeCaptureManifest", () => {
		const capture = toCaptureManifest({
			stage: "triage",
			model: "sonnet",
			outcomes: [completedRun()],
		});
		const decoded = decodeCaptureManifest(captureToJson(capture));
		assert.isTrue(Result.isSuccess(decoded));
	});

	it("collectFromCapture folds it against the corpus with no change to the collector", () => {
		const corpus: CorpusManifest = {
			version: 1,
			stages: {
				triage: [
					{stage: "triage", inputRef: 1, label: {type: "bug", priority: "p0", status: "triaged"}},
				],
				build: [],
				review: [],
				"ship-it": [],
			},
		};
		const outcome = classifyRun({
			plan: plan({jsonSchema: "{}"}),
			exec: exited(
				resultStdout({structured_output: {type: "bug", priority: "p0", status: "triaged"}}),
			),
			transcriptPath: "/t.jsonl",
			spend: classifyRunSpend(billedTranscript),
		});
		const rows = Effect.runSync(
			collectFromCapture({
				stage: "triage",
				corpus,
				capture: toCaptureManifest({stage: "triage", model: "sonnet", outcomes: [outcome]}),
				loadTranscript: () => Effect.succeed(billedTranscript),
			}),
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]?.grade.status, "pass");
	});
});

/**
 * #4996: the run's pinned provenance rides the manifest, which is the artifact that outlives the
 * ledger. The fold is where the model and arm are still in hand, so it is where they are recorded.
 */
describe("toCaptureManifest — a manifest run names the model it was pinned to and its arm", () => {
	it("stamps the suite's pinned model and each run's own arm onto its manifest row", () => {
		const outcomes: ReadonlyArray<RunOutcome> = [
			completedRun(),
			completedRun({plan: plan({caseId: 2, arm: "without-skill"})}),
		];
		const capture = toCaptureManifest({stage: "triage", model: "opus-4.8", outcomes});
		assert.deepStrictEqual(
			capture.runs.map((run) => ({inputRef: run.inputRef, model: run.model, arm: run.arm})),
			[
				{inputRef: 1, model: "opus-4.8", arm: "with-skill"},
				{inputRef: 2, model: "opus-4.8", arm: "without-skill"},
			],
		);
	});

	it("the provenance survives the JSON round-trip the collector reads", () => {
		const capture = toCaptureManifest({
			stage: "triage",
			model: "opus-4.8",
			outcomes: [completedRun({plan: plan({arm: "without-skill"})})],
		});
		const decoded = decodeCaptureManifest(captureToJson(capture));
		assert.isTrue(Result.isSuccess(decoded));
		if (Result.isSuccess(decoded)) {
			assert.strictEqual(decoded.success.runs[0]?.model, "opus-4.8");
			assert.strictEqual(decoded.success.runs[0]?.arm, "without-skill");
		}
	});
});

describe("suiteExecuted — fails closed on zero scope and on any dead run (ADR 0092)", () => {
	it("a suite that planned nothing is red, never a green that checked nothing", () => {
		assert.isFalse(suiteExecuted(summarizeRuns([])));
	});

	it("one dead run reds the suite", () => {
		const outcomes: ReadonlyArray<RunOutcome> = [
			completedRun(),
			classifyRun({
				plan: plan({caseId: 2}),
				exec: {_tag: "TimedOut", boundMs: 1},
				transcriptPath: null,
				spend: classifyRunSpend(null),
			}),
		];
		assert.isFalse(suiteExecuted(summarizeRuns(outcomes)));
	});

	it("an all-collected suite is green", () => {
		assert.isTrue(suiteExecuted(summarizeRuns([completedRun()])));
	});
});

/**
 * #5008: the reconstructed spend stops being thrown away. The suite below drives the whole path —
 * stubbed executor, stubbed transcript loader, no model call and no spawn — and its centre of gravity
 * is the states that are NOT a number: a run whose transcript went missing and a run that billed
 * nothing must each stay their own recorded state rather than collapse into a measured zero.
 */
describe("recorded spend — every completed run's number, attributed to the run that produced it", () => {
	const ONE_RULER = readFileSync(
		fileURLToPath(new URL("../spend/fixtures/one-ruler/transcript.jsonl", import.meta.url)),
		"utf8",
	);
	const ONE_RULER_EXPECTED = JSON.parse(
		readFileSync(
			fileURLToPath(new URL("../spend/fixtures/one-ruler/expected.json", import.meta.url)),
			"utf8",
		),
	) as {billed: number; exCacheRead: number};

	const suite = {
		skillName: "probe",
		stage: "triage",
		model: "sonnet",
		cliVersion: "2.1.220",
		recordedAt: "2026-08-09T00:00:00Z",
	} as const;

	const ledgerOver = (loadTranscript: () => Effect.Effect<string | null>) => {
		const plans = Effect.runSync(
			planEvalRuns({
				cases: [CASES[0] as RunnableCase],
				arms: BOTH_ARMS,
				model: suite.model,
				pluginDir: "/candidate",
				jsonSchema: null,
				sessionId: (id, arm) => Effect.succeed(`${id}-${arm}`),
			}),
		);
		const outcomes = Effect.runSync(
			executeRuns({
				plans,
				executor: () => Effect.succeed(exited(resultStdout())),
				locateTranscript: (sessionId) => Effect.succeed(`/data/${sessionId}.jsonl`),
				loadTranscript,
			}),
		);
		return buildLedger({...suite, outcomes});
	};

	it("carries every attribution field on each completed run's row", () => {
		const ledger = ledgerOver(() => Effect.succeed(ONE_RULER));
		assert.strictEqual(ledger.spendRows.length, 2);
		assert.deepStrictEqual(ledger.spendRows[0], {
			skillName: "probe",
			stage: "triage",
			caseId: 1,
			arm: "with-skill",
			model: "sonnet",
			sessionId: "1-with-skill",
			cliVersion: "2.1.220",
			recordedAt: "2026-08-09T00:00:00Z",
			spend: classifyRunSpend(ONE_RULER),
		});
		assert.strictEqual(ledger.spendRows[1]?.arm, "without-skill");
	});

	it("takes its figures from the shared one-ruler meter rather than a second sum", () => {
		const row = ledgerOver(() => Effect.succeed(ONE_RULER)).spendRows[0];
		assert.strictEqual(row?.spend._tag, "Reconstructed");
		if (row?.spend._tag !== "Reconstructed") return;
		assert.strictEqual(row.spend.spend.billed, ONE_RULER_EXPECTED.billed);
		assert.strictEqual(row.spend.spend.exCacheRead, ONE_RULER_EXPECTED.exCacheRead);
	});

	it("records a completed run whose transcript went missing as TranscriptMissing, never a zero", () => {
		const ledger = ledgerOver(() => Effect.succeed(null));
		assert.strictEqual(ledger.spendRows.length, 2);
		assert.strictEqual(ledger.spendRows[0]?.spend._tag, "TranscriptMissing");
		assert.strictEqual(totalSpend(ledger.spendRows).measured, 0);
		assert.strictEqual(totalSpend(ledger.spendRows).transcriptMissing, 2);
	});

	it("keeps a zero-billed-turn run its own state — counted as a dead run, never a spend row", () => {
		const ledger = ledgerOver(() => Effect.succeed('{"type":"summary"}'));
		assert.deepStrictEqual(ledger.spendRows, []);
		assert.strictEqual(ledger.summary.byFailure["NoModelTurns:zero-assistant-turns"], 2);
	});

	it("gives a failed run no spend row at all", () => {
		const ledger = buildLedger({
			...suite,
			outcomes: [
				completedRun({spend: classifyRunSpend(ONE_RULER)}),
				classifyRun({
					plan: plan({caseId: 2}),
					exec: {_tag: "TimedOut", boundMs: 1},
					transcriptPath: null,
					spend: classifyRunSpend(null),
				}),
			],
		});
		assert.strictEqual(ledger.spendRows.length, 1);
		assert.strictEqual(ledger.spendRows[0]?.caseId, 1);
	});

	it("totals only the measured rows and names the ones it could not measure", () => {
		const rows = buildLedger({
			...suite,
			outcomes: [
				completedRun({spend: classifyRunSpend(ONE_RULER)}),
				completedRun({plan: plan({caseId: 2}), spend: classifyRunSpend(null)}),
			],
		}).spendRows;
		assert.deepStrictEqual(totalSpend(rows), {
			measured: 1,
			noBilledTurns: 0,
			transcriptMissing: 1,
			billed: ONE_RULER_EXPECTED.billed,
			exCacheRead: ONE_RULER_EXPECTED.exCacheRead,
		});
	});

	it("prints per-run billed and ex-cache-read figures plus a suite total", () => {
		const rendered = renderLedger(ledgerOver(() => Effect.succeed(ONE_RULER)));
		assert.include(rendered, `billed ${ONE_RULER_EXPECTED.billed}`);
		assert.include(rendered, `ex-cache-read ${ONE_RULER_EXPECTED.exCacheRead}`);
		assert.include(rendered, `spend: billed ${ONE_RULER_EXPECTED.billed * 2}`);
		assert.include(rendered, `ex-cache-read ${ONE_RULER_EXPECTED.exCacheRead * 2}`);
		assert.include(rendered, "2 measured run(s)");
	});

	it("says a run's spend is unmeasured rather than printing it as 0", () => {
		const rendered = renderLedger(ledgerOver(() => Effect.succeed(null)));
		assert.include(rendered, "billed n/a (transcript missing)");
		assert.notInclude(rendered, "billed 0");
		assert.include(rendered, "0 measured run(s)");
	});
});

describe("flag parsing", () => {
	it("accepts the known arms, de-duplicated, and rejects anything else", () => {
		assert.deepStrictEqual(parseArms("with-skill, without-skill"), ["with-skill", "without-skill"]);
		assert.deepStrictEqual(parseArms("with-skill,with-skill"), ["with-skill"]);
		assert.strictEqual(parseArms("with-skil"), null);
		assert.strictEqual(parseArms(""), null);
	});

	it("accepts only live stage names", () => {
		assert.isTrue(isStageName("build"));
		assert.isTrue(isStageName("review"));
		assert.isFalse(isStageName("review-skill"));
		// `write-code` and the two v1 review keys survive only as a recorded row's provenance key
		// (#4977) — never as live stages. The surfaces are a sub-key of `review`, not stages (ADR 0243).
		assert.isFalse(isStageName("write-code"));
		assert.isFalse(isStageName("review-code"));
		assert.isFalse(isStageName("review-doc"));
	});
});

/**
 * The founder ruling on epic #4649 (comment 5153280445) removes model-in-the-loop execution from CI
 * on a cost constraint. Asserting it here rather than in prose is the difference between a rule and
 * a note: the runner's model-spawning verb cannot be wired into a workflow without this reddening.
 */
describe("no CI workflow invokes the model-spawning runner (#4649 ruling)", () => {
	const workflows = fileURLToPath(new URL("../../../../.github/workflows", import.meta.url));

	it("finds workflow files at all — fail closed on zero scope (ADR 0092)", () => {
		assert.isAbove(readdirSync(workflows).filter((f) => f.endsWith(".yml")).length, 0);
	});

	// Both spellings, so the ruling survives the rename: v1's `eval-harness run` and fabrika's
	// `eval run` are the same forbidden invocation, and a workflow written against either reds.
	it("no workflow calls the runner under either verb name", () => {
		const offenders = readdirSync(workflows)
			.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
			.filter((f) =>
				/(eval-harness|fabrika(-cli)?\s+eval)\s+run\b/.test(
					readFileSync(join(workflows, f), "utf8"),
				),
			);
		assert.deepStrictEqual(offenders, []);
	});
});
