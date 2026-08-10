/**
 * `eval` spawn-and-collect core — planning an unattended eval run and classifying what came
 * back (issue #4676, epic #4649).
 *
 * This is the **pure** half of the execution layer: it plans the invocations, builds their argv,
 * decodes the headless result payload, and classifies each run into a typed outcome. It reaches no
 * platform service itself — the spawning and the file reads live in `spawn-io.ts` behind the seams
 * below, so the module's offline replay path (`runner.ts`) stays reproducible and this core stays
 * unit-testable against a stubbed executor. See ADR 0236 for why the module gained a spawning shell
 * at all.
 *
 * The invocation contract below is **measured, not inferred** — every flag comes from the #4673
 * spike's evidence log (comment 5153355534 on that issue), re-verified here against `claude`
 * 2.1.220.
 *
 * The one thing that shapes everything else: **an unresolvable skill is a silent green.**
 * `claude -p "/not-a-skill"` exits 0 with `is_error: false`, `subtype: "success"`, `num_turns: 0`,
 * `total_cost_usd: 0`, `modelUsage: {}` — and `token-spend` reconstructs its transcript to
 * well-formed zeros, also at exit 0. Nothing in the platform reports the failure, so a with-skill
 * arm whose plugin failed to load degrades into a without-skill arm and scores as a legitimate free
 * run. `classifyRun` therefore synthesizes the missing signal (`NO_MODEL_TURNS_SIGNALS`), and its
 * verdict is the one place a run is allowed to become a `CaptureRun`.
 */
import {Effect, Result} from "effect";
import {canonicalModel} from "../models.ts";
import {classifyRunSpend, type RunSpend} from "../spend/token-spend.ts";
import {STAGES} from "./corpus.ts";
import {
	type CaptureManifest,
	type CaptureRun,
	EVAL_ARMS,
	type EvalArm,
	type TranscriptLoader,
} from "./runner.ts";
import type {EvalTier} from "./skill-eval-set.ts";

// The arm vocabulary lives with the `CaptureRun` schema that constrains it (`runner.ts`); it is
// re-exported here because this is where its consumers have always imported it from.
export {EVAL_ARMS, type EvalArm};

/**
 * The minimum a case must offer to be run. Declared structurally rather than imported as
 * `SkillEvalCase` so the executor never depends on the authored format's other fields — a decoded
 * `SkillEvalCase` satisfies it, and so does a synthetic case in a test.
 */
export interface RunnableCase {
	readonly id: number;
	readonly prompt: string;
	readonly tier: EvalTier;
}

/**
 * The one spelling a run is pinned under: `--model`'s value canonicalized through fabrika's single
 * alias table (`../models.ts`), which declares it — nothing here holds a second copy (ADR 0238).
 *
 * Normalize-only, by the ruling on #5148: an alias resolves to its canonical id, and **everything
 * else passes through unchanged** — no allowlist, no default, no rejection — so a model the table
 * has never seen still runs and #4680's model-churn re-run contract (ADR 0236 §2) survives. The
 * `?? model` arm keeps a blank value exactly as unnormalized as it is today; refusing it here would
 * be the rejection the ruling rules out.
 */
const pinnedModel = (model: string): string => canonicalModel(model) ?? model;

/** One planned invocation: exactly one (case × arm), with the session id its transcript will land under. */
export interface PlannedRun {
	readonly caseId: number;
	readonly tier: EvalTier;
	readonly arm: EvalArm;
	readonly sessionId: string;
	readonly prompt: string;
	readonly model: string;
	/** The candidate skill's plugin dir on the with-skill arm; `null` is what makes the other arm the other arm. */
	readonly pluginDir: string | null;
	/** The JSON schema text requested for the decision artifact, or `null` when none was asked for. */
	readonly jsonSchema: string | null;
}

/**
 * Plan one invocation per (case × arm). `sessionId` is minted by the caller — through the `Crypto`
 * service in the bin, a fixed sequence in a test — because pinning it is what makes the transcript
 * locatable afterwards: the result payload carries `session_id` but never the transcript path
 * (#4673 §7). It is the one effect in the planner, which is why the planner returns an `Effect`.
 */
export const planEvalRuns = <R>(args: {
	readonly cases: ReadonlyArray<RunnableCase>;
	readonly arms: ReadonlyArray<EvalArm>;
	readonly model: string;
	readonly pluginDir: string;
	readonly jsonSchema: string | null;
	readonly sessionId: (caseId: number, arm: EvalArm) => Effect.Effect<string, never, R>;
}): Effect.Effect<ReadonlyArray<PlannedRun>, never, R> =>
	Effect.gen(function* () {
		const plans: Array<PlannedRun> = [];
		for (const evalCase of args.cases) {
			for (const arm of args.arms) {
				plans.push({
					caseId: evalCase.id,
					tier: evalCase.tier,
					arm,
					sessionId: yield* args.sessionId(evalCase.id, arm),
					prompt: evalCase.prompt,
					model: pinnedModel(args.model),
					pluginDir: arm === "with-skill" ? args.pluginDir : null,
					jsonSchema: args.jsonSchema,
				});
			}
		}
		return plans;
	});

/**
 * The argv for one planned run, minus the executable.
 *
 * Two flags are deliberately absent and must stay absent. `--no-session-persistence` would suppress
 * the transcript this whole path is built to collect, and `--disable-slash-commands` silently
 * short-circuits a `/<skill>` prompt (both #4673 §4/§7).
 */
export const buildClaudeArgs = (plan: PlannedRun): ReadonlyArray<string> => [
	"-p",
	plan.prompt,
	"--output-format",
	"json",
	"--session-id",
	plan.sessionId,
	"--model",
	plan.model,
	...(plan.pluginDir === null ? [] : ["--plugin-dir", plan.pluginDir]),
	...(plan.jsonSchema === null ? [] : ["--json-schema", plan.jsonSchema]),
];

/** What the executor observed. Total: a dead or wedged child is a value here, never an exception. */
export type ExecutorResult =
	| {
			readonly _tag: "Exited";
			readonly code: number;
			readonly stdout: string;
			readonly stderr: string;
	  }
	| {readonly _tag: "TimedOut"; readonly boundMs: number}
	| {readonly _tag: "SpawnFailed"; readonly detail: string};

/**
 * The seam the unit tier stubs: a planned run in, an observation out. No model call in a unit test.
 *
 * `R` is the platform requirement the *implementation* carries — `ChildProcessSpawner` for the real
 * one, `never` for a stub — so this core names no platform service of its own.
 */
export type Executor<R = never> = (plan: PlannedRun) => Effect.Effect<ExecutorResult, never, R>;

/** The fields of the headless `result` message this runner reads. Everything else in it is ignored. */
export interface HeadlessResult {
	readonly isError: boolean;
	readonly subtype: string;
	readonly numTurns: number;
	readonly text: string;
	readonly sessionId: string;
	readonly modelUsageKeys: ReadonlyArray<string>;
	readonly totalCostUsd: number | null;
	readonly hasStructuredOutput: boolean;
	readonly structuredOutput: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Find the `result` message in a headless run's stdout.
 *
 * `--output-format json` emits a **JSON array of stream messages** (`system/init`, `assistant`,
 * `result`) on 2.1.220 — measured, and a correction to the spike, which described the top level as
 * the result object itself. Both shapes are read: the last `type: "result"` element of an array, or
 * a bare object that already is one. Reading only one of them would make the runner version-brittle
 * in the direction that matters least safely — a missed result reads as a dead run.
 */
const findResultMessage = (parsed: unknown): Record<string, unknown> | null => {
	if (Array.isArray(parsed)) {
		for (let i = parsed.length - 1; i >= 0; i -= 1) {
			const message: unknown = parsed[i];
			if (isRecord(message) && message.type === "result") return message;
		}
		return null;
	}
	if (isRecord(parsed) && (parsed.type === "result" || parsed.type === undefined)) {
		return parsed;
	}
	return null;
};

const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * Decode a headless run's stdout into the fields the guard needs, or `null` when it holds no
 * readable result message.
 *
 * Hand-read rather than schema-decoded on purpose: the payload carries a dozen fields that vary by
 * CLI version, and a strict decode would turn a harmless new key into a dead run. Every field is
 * read defensively and a missing one degrades to the value that makes `classifyRun` *stricter*
 * (zero turns, no model usage, no structured output), never to a pass.
 */
export const decodeHeadlessResult = (stdout: string): HeadlessResult | null => {
	const parsed = Result.try({try: (): unknown => JSON.parse(stdout), catch: () => null});
	if (Result.isFailure(parsed)) return null;
	const message = findResultMessage(parsed.success);
	if (message === null) return null;
	const modelUsage = message.modelUsage;
	return {
		isError: message.is_error === true,
		subtype: typeof message.subtype === "string" ? message.subtype : "",
		numTurns: asNumber(message.num_turns) ?? 0,
		text: typeof message.result === "string" ? message.result : "",
		sessionId: typeof message.session_id === "string" ? message.session_id : "",
		modelUsageKeys: isRecord(modelUsage) ? Object.keys(modelUsage) : [],
		totalCostUsd: asNumber(message.total_cost_usd),
		hasStructuredOutput: message.structured_output !== undefined,
		structuredOutput: message.structured_output,
	};
};

/**
 * The five ways a run can report success while never having reached a model. Each is an independent
 * observation of the same hazard, kept separate so a ledger names *which* one fired — "the plugin
 * did not load" and "the schema was ignored" are different repairs.
 */
export const NO_MODEL_TURNS_SIGNALS = [
	"unknown-command",
	"zero-turns",
	"empty-model-usage",
	"zero-assistant-turns",
	"missing-structured-output",
] as const;

export type NoModelTurnsSignal = (typeof NO_MODEL_TURNS_SIGNALS)[number];

/** Why a run is not collectable. Every arm is counted; none is ever scored as a pass. */
export type RunFailure =
	| {readonly _tag: "SpawnFailed"; readonly detail: string}
	| {readonly _tag: "TimedOut"; readonly boundMs: number}
	| {readonly _tag: "UndecodableResult"; readonly detail: string}
	| {readonly _tag: "ReportedError"; readonly detail: string}
	| {readonly _tag: "NoModelTurns"; readonly signal: NoModelTurnsSignal; readonly detail: string}
	| {readonly _tag: "TranscriptNotFound"; readonly sessionId: string};

/** One executed run: collectable, or a typed counted failure. There is no third state. */
export type RunOutcome =
	| {
			readonly _tag: "Completed";
			readonly caseId: number;
			readonly tier: EvalTier;
			readonly arm: EvalArm;
			readonly sessionId: string;
			readonly transcriptPath: string;
			readonly artifact: unknown;
			readonly numTurns: number;
			readonly totalCostUsd: number | null;
			/**
			 * What the run's transcript reconstructed to. The three-arm union is reused verbatim rather
			 * than narrowed to a `StageSpend`, so a transcript that could not be read stays visibly
			 * unmeasured instead of arriving in the ledger as a zero somebody would read as free.
			 */
			readonly spend: RunSpend;
	  }
	| {
			readonly _tag: "Failed";
			readonly caseId: number;
			readonly tier: EvalTier;
			readonly arm: EvalArm;
			readonly sessionId: string;
			readonly failure: RunFailure;
	  };

const failed = (plan: PlannedRun, failure: RunFailure): RunOutcome => ({
	_tag: "Failed",
	caseId: plan.caseId,
	tier: plan.tier,
	arm: plan.arm,
	sessionId: plan.sessionId,
	failure,
});

/**
 * Detect a run that reported success without reaching a model. Order is by specificity: the
 * `Unknown command:` prefix names the actual cause, so it is reported ahead of the `num_turns === 0`
 * that always accompanies it.
 *
 * `assistantTurns` is the transcript's own reconstruction, passed in rather than computed here so
 * this stays pure; `null` means no transcript was read yet, which is not itself a signal —
 * `TranscriptNotFound` covers that separately.
 */
const noModelTurns = (args: {
	readonly result: HeadlessResult;
	readonly schemaRequested: boolean;
	readonly assistantTurns: number | null;
}): {readonly signal: NoModelTurnsSignal; readonly detail: string} | null => {
	const {result} = args;
	if (/^Unknown command:/.test(result.text)) {
		return {signal: "unknown-command", detail: result.text};
	}
	if (result.numTurns === 0) {
		return {signal: "zero-turns", detail: "the run reported num_turns: 0"};
	}
	if (result.modelUsageKeys.length === 0) {
		return {signal: "empty-model-usage", detail: "the run reported an empty modelUsage"};
	}
	if (args.assistantTurns === 0) {
		return {
			signal: "zero-assistant-turns",
			detail: "the transcript reconstructs to zero billed assistant turns",
		};
	}
	if (args.schemaRequested && !result.hasStructuredOutput) {
		return {
			signal: "missing-structured-output",
			detail: "a --json-schema was requested but the result carried no structured_output",
		};
	}
	return null;
};

/**
 * The billed-turn count a `RunSpend` attests, or `null` when there is no transcript to attest one.
 * Deriving it from the union rather than taking it alongside is what makes a count that disagrees
 * with the spend it was measured from unrepresentable.
 */
const billedTurns = (spend: RunSpend): number | null => {
	if (spend._tag === "TranscriptMissing") return null;
	return spend._tag === "NoBilledTurns" ? 0 : spend.spend.assistantTurns;
};

/**
 * Classify one executed run. This is the fail-closed seam: only a run that survives every check
 * becomes `Completed`, and only a `Completed` run reaches the capture manifest.
 */
export const classifyRun = (args: {
	readonly plan: PlannedRun;
	readonly exec: ExecutorResult;
	readonly transcriptPath: string | null;
	readonly spend: RunSpend;
}): RunOutcome => {
	const {plan, exec} = args;
	if (exec._tag === "SpawnFailed") return failed(plan, {_tag: "SpawnFailed", detail: exec.detail});
	if (exec._tag === "TimedOut") return failed(plan, {_tag: "TimedOut", boundMs: exec.boundMs});

	const result = decodeHeadlessResult(exec.stdout);
	if (result === null) {
		return failed(plan, {
			_tag: "UndecodableResult",
			detail: `exit ${exec.code}: stdout carried no readable result message`,
		});
	}
	if (result.isError) {
		return failed(plan, {_tag: "ReportedError", detail: result.text || result.subtype});
	}

	const silentGreen = noModelTurns({
		result,
		schemaRequested: plan.jsonSchema !== null,
		assistantTurns: billedTurns(args.spend),
	});
	if (silentGreen !== null) {
		return failed(plan, {_tag: "NoModelTurns", ...silentGreen});
	}
	if (args.transcriptPath === null) {
		return failed(plan, {_tag: "TranscriptNotFound", sessionId: plan.sessionId});
	}

	return {
		_tag: "Completed",
		caseId: plan.caseId,
		tier: plan.tier,
		arm: plan.arm,
		sessionId: plan.sessionId,
		transcriptPath: args.transcriptPath,
		// `null`, never `undefined`, when no schema was requested: `JSON.stringify` drops an
		// undefined value entirely, and the written manifest would then fail the existing
		// `decodeCaptureManifest` on a missing required key.
		artifact: result.hasStructuredOutput ? result.structuredOutput : null,
		numTurns: result.numTurns,
		totalCostUsd: result.totalCostUsd,
		spend: args.spend,
	};
};

/**
 * Execute a planned suite and classify every run.
 *
 * Pure in the sense that matters: the three effects it needs are parameters, so the unit tier drives
 * it with a stubbed executor and no model call. It is also the "the suite still completes" guarantee
 * — a case that dies is classified and the loop continues to the next one, never aborting the run.
 */
export const executeRuns = <RE, RL, RT>(args: {
	readonly plans: ReadonlyArray<PlannedRun>;
	readonly executor: Executor<RE>;
	readonly locateTranscript: (sessionId: string) => Effect.Effect<string | null, never, RL>;
	readonly loadTranscript: TranscriptLoader<RT>;
}): Effect.Effect<ReadonlyArray<RunOutcome>, never, RE | RL | RT> =>
	Effect.gen(function* () {
		const outcomes: Array<RunOutcome> = [];
		for (const plan of args.plans) {
			const exec = yield* args.executor(plan);
			const transcriptPath = yield* args.locateTranscript(plan.sessionId);
			const transcript =
				transcriptPath === null ? null : yield* args.loadTranscript(transcriptPath);
			outcomes.push(classifyRun({plan, exec, transcriptPath, spend: classifyRunSpend(transcript)}));
		}
		return outcomes;
	});

/**
 * Fold the completed runs into the capture-manifest shape `collectFromCapture` already consumes —
 * the whole point of the runner's output (#4676 AC2). `stage` is named by the operator (a skill's
 * eval set exercises one pipeline stage) and `inputRef` is the case id, which is what joins a run
 * to its corpus ground truth. A `Failed` run contributes nothing: an uncollected run cannot be
 * graded, and grading it would be the fabricated pass this whole guard exists to prevent.
 *
 * Each run also carries the model it was pinned to and the arm it belongs to, because the manifest
 * is the artifact that outlives the ledger: a scorecard built from it alone would otherwise have to
 * recover the model from a machine-local transcript, and would say `(unknown)` when that transcript
 * is gone (#4996).
 */
export const toCaptureManifest = (args: {
	readonly stage: CaptureRun["stage"];
	readonly model: string;
	readonly outcomes: ReadonlyArray<RunOutcome>;
}): CaptureManifest => ({
	version: 1,
	runs: args.outcomes.flatMap((outcome) =>
		outcome._tag === "Completed"
			? [
					{
						stage: args.stage,
						inputRef: outcome.caseId,
						transcriptPath: outcome.transcriptPath,
						artifact: outcome.artifact,
						model: args.model,
						arm: outcome.arm,
					},
				]
			: [],
	),
});

/**
 * One completed run's reconstructed spend plus the identity of the run that produced it — the
 * epic's **spend row** (#4779). Every attribution field is copied onto the row rather than left on
 * the ledger header, because a row is meant to survive on its own: the persistence slice appends
 * these one per line, and a line that cannot name what it measured is a number with no unit of work.
 *
 * `stage` here is **provenance** — the key this run was recorded under, never a pointer into the
 * live stage table (#4977). A recorded row keeps the key it was written with, and is never re-keyed.
 */
export interface SpendRow {
	readonly skillName: string;
	readonly stage: CaptureRun["stage"];
	readonly caseId: number;
	readonly arm: EvalArm;
	/** The model the run was pinned to, which is the axis a scorecard compares along. */
	readonly model: string;
	readonly sessionId: string;
	readonly cliVersion: string | null;
	/** ISO-8601 UTC, supplied by the shell — the core mints no time of its own. */
	readonly recordedAt: string;
	readonly spend: RunSpend;
}

/**
 * The spend rows of a suite: one per **completed** run. A `Failed` run contributes none — it produced
 * no measurable work, and a row for it would be a zero standing where a measurement never happened.
 */
export const toSpendRows = (args: {
	readonly skillName: string;
	readonly stage: CaptureRun["stage"];
	readonly model: string;
	readonly cliVersion: string | null;
	readonly recordedAt: string;
	readonly outcomes: ReadonlyArray<RunOutcome>;
}): ReadonlyArray<SpendRow> =>
	args.outcomes.flatMap((outcome) =>
		outcome._tag === "Completed"
			? [
					{
						skillName: args.skillName,
						stage: args.stage,
						caseId: outcome.caseId,
						arm: outcome.arm,
						model: args.model,
						sessionId: outcome.sessionId,
						cliVersion: args.cliVersion,
						recordedAt: args.recordedAt,
						spend: outcome.spend,
					},
				]
			: [],
	);

/**
 * A suite's summed spend, alongside the count of rows that contributed nothing to it. The two
 * unmeasured counts are part of the total, not a footnote: a bare `billed` says nothing about how
 * many runs it covers, and a reader who cannot see the gap will read it as covering all of them.
 */
export interface SuiteSpend {
	readonly measured: number;
	readonly noBilledTurns: number;
	readonly transcriptMissing: number;
	readonly billed: number;
	readonly exCacheRead: number;
}

export const totalSpend = (rows: ReadonlyArray<SpendRow>): SuiteSpend => {
	let measured = 0;
	let noBilledTurns = 0;
	let transcriptMissing = 0;
	let billed = 0;
	let exCacheRead = 0;
	for (const row of rows) {
		if (row.spend._tag === "NoBilledTurns") {
			noBilledTurns += 1;
			continue;
		}
		if (row.spend._tag === "TranscriptMissing") {
			transcriptMissing += 1;
			continue;
		}
		measured += 1;
		billed += row.spend.spend.billed;
		exCacheRead += row.spend.spend.exCacheRead;
	}
	return {measured, noBilledTurns, transcriptMissing, billed, exCacheRead};
};

/** The counted shape of a suite: how many ran, how many died, and of what. */
export interface RunSummary {
	readonly planned: number;
	readonly completed: number;
	readonly failed: number;
	readonly byFailure: Readonly<Record<string, number>>;
	readonly byArm: Readonly<Record<EvalArm, {readonly completed: number; readonly failed: number}>>;
}

export const summarizeRuns = (outcomes: ReadonlyArray<RunOutcome>): RunSummary => {
	const byFailure: Record<string, number> = {};
	const byArm: Record<EvalArm, {completed: number; failed: number}> = {
		"with-skill": {completed: 0, failed: 0},
		"without-skill": {completed: 0, failed: 0},
	};
	let completed = 0;
	for (const outcome of outcomes) {
		if (outcome._tag === "Completed") {
			completed += 1;
			byArm[outcome.arm].completed += 1;
			continue;
		}
		byArm[outcome.arm].failed += 1;
		const key =
			outcome.failure._tag === "NoModelTurns"
				? `NoModelTurns:${outcome.failure.signal}`
				: outcome.failure._tag;
		byFailure[key] = (byFailure[key] ?? 0) + 1;
	}
	return {
		planned: outcomes.length,
		completed,
		failed: outcomes.length - completed,
		byFailure,
		byArm,
	};
};

/**
 * Whether the suite executed. Fail-closed in both directions ADR 0092 names: a suite that planned
 * nothing reports red (a zero-case run that exits green is the zero-scope pass the epic exists to
 * end), and so does one where any case died. This says nothing about whether the cases *passed* —
 * grading is `oracle.ts`'s, and the tier verbs' (#4677/#4678), never this verb's.
 */
export const suiteExecuted = (summary: RunSummary): boolean =>
	summary.planned > 0 && summary.failed === 0;

/**
 * The runner's on-disk output: the ledger of every planned run's typed outcome, plus the capture
 * manifest folded out of the collectable ones. Both arms are in `runs`, each naming its own, and
 * since #4996 each `CaptureRun` names its own arm and model too — so with-skill and without-skill
 * stay distinguishable after collection even where only the manifest survives.
 */
export interface RunLedger {
	readonly version: 1;
	readonly skillName: string;
	readonly stage: CaptureRun["stage"];
	readonly model: string;
	readonly cliVersion: string | null;
	/** When the suite was recorded, ISO-8601 UTC — stamped once and copied onto every spend row. */
	readonly recordedAt: string;
	readonly runs: ReadonlyArray<RunOutcome>;
	readonly capture: CaptureManifest;
	readonly spendRows: ReadonlyArray<SpendRow>;
	readonly summary: RunSummary;
}

export const buildLedger = (args: {
	readonly skillName: string;
	readonly stage: CaptureRun["stage"];
	readonly model: string;
	readonly cliVersion: string | null;
	readonly recordedAt: string;
	readonly outcomes: ReadonlyArray<RunOutcome>;
}): RunLedger => {
	// The recorded model is canonicalized here too, not only on the plans: the capture manifest and
	// the spend rows are what the scorecard buckets on, and a header spelt differently from the argv
	// would split one model across two cells (#5158).
	const model = pinnedModel(args.model);
	return {
		version: 1,
		skillName: args.skillName,
		stage: args.stage,
		model,
		cliVersion: args.cliVersion,
		recordedAt: args.recordedAt,
		runs: args.outcomes,
		capture: toCaptureManifest({...args, model}),
		spendRows: toSpendRows({...args, model}),
		summary: summarizeRuns(args.outcomes),
	};
};

/** The stage names a `--stage` flag accepts — re-exported so the shell needn't reach into `runner.ts`. */
export const isStageName = (value: string): value is CaptureRun["stage"] =>
	(STAGES as ReadonlyArray<string>).includes(value);

/** Parse a comma-separated `--arms` value; `null` when it names anything that is not an arm. */
export const parseArms = (value: string): ReadonlyArray<EvalArm> | null => {
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	if (parts.length === 0) return null;
	const arms: Array<EvalArm> = [];
	for (const part of parts) {
		if (!(EVAL_ARMS as ReadonlyArray<string>).includes(part)) return null;
		if (!arms.includes(part as EvalArm)) arms.push(part as EvalArm);
	}
	return arms;
};

/** The ledger's stable JSON form — sorted keys are not needed, but a trailing newline is. */
export const ledgerToJson = (ledger: RunLedger): string => `${JSON.stringify(ledger, null, 2)}\n`;

export const captureToJson = (capture: CaptureManifest): string =>
	`${JSON.stringify(capture, null, 2)}\n`;

/**
 * The two figures for one run, or the named reason there are none. An unmeasured run reads
 * `n/a (…)` rather than `0`, because the whole point of the three-arm union is that those are
 * different facts and a rendered `0` would erase the difference at the last step.
 */
const renderRunSpend = (spend: RunSpend): string => {
	if (spend._tag === "TranscriptMissing") return "billed n/a (transcript missing)";
	if (spend._tag === "NoBilledTurns") return "billed n/a (no billed turns)";
	return `billed ${spend.spend.billed}, ex-cache-read ${spend.spend.exCacheRead}`;
};

/** The suite total, and the gap it does not cover. A suite that measured nothing prints no figures. */
const renderSuiteSpend = (total: SuiteSpend): string => {
	const unmeasured = [
		total.transcriptMissing > 0 ? `${total.transcriptMissing} transcript-missing` : null,
		total.noBilledTurns > 0 ? `${total.noBilledTurns} no-billed-turns` : null,
	].filter((part) => part !== null);
	const gap = unmeasured.length === 0 ? "" : ` (${unmeasured.join(", ")})`;
	if (total.measured === 0) return `  spend: unmeasured — 0 measured run(s)${gap}`;
	return `  spend: billed ${total.billed} · ex-cache-read ${total.exCacheRead} over ${total.measured} measured run(s)${gap}`;
};

/** A one-line-per-run human rendering, so an operator sees which arm died of what without a jq. */
export const renderLedger = (ledger: RunLedger): string => {
	const lines = [
		`fabrika eval run: ${ledger.skillName} · stage ${ledger.stage} · model ${ledger.model}`,
		...ledger.runs.map((outcome) =>
			outcome._tag === "Completed"
				? `  case ${outcome.caseId} [${outcome.arm}] ok — ${outcome.numTurns} turns, ${renderRunSpend(outcome.spend)}, transcript ${outcome.transcriptPath}`
				: `  case ${outcome.caseId} [${outcome.arm}] FAILED — ${outcome.failure._tag}${
						outcome.failure._tag === "NoModelTurns" ? `:${outcome.failure.signal}` : ""
					}`,
		),
		`  planned ${ledger.summary.planned} · collected ${ledger.summary.completed} · failed ${ledger.summary.failed}`,
		renderSuiteSpend(totalSpend(ledger.spendRows)),
	];
	return lines.join("\n");
};
