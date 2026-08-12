/**
 * The graded axis — the reused grader-agent judgment path at five runs and a median (issue #4678,
 * epic #4649).
 *
 * The deterministic tier (`deterministic-tier.ts`) runs a mechanically-checkable case once. A case
 * carrying even one judgment assertion cannot be read off an exit status, so it comes here: the case
 * is executed **five times**, each execution is judged by the grader-agent pattern the authoring
 * tool already uses, and the case's verdict is the **median** of those five (founder ruling 4 on
 * #4637).
 *
 * **No rubric is invented here.** The grader is handed the case's own authored `expected_output` and
 * `expectations` verbatim ({@link composeGraderPrompt}), so the judgment a case receives in a review
 * is the judgment its authoring session defined. This module owns the protocol around that pattern —
 * five runs, the median, what a dead invocation counts as — and nothing about what "good" means.
 *
 * Two arithmetic definitions come from ADR 0252 §1 and are not re-derived: `dispersion` is the
 * minority-verdict count, and the per-run verdicts are retained beside it so a reader re-derives the
 * aggregate instead of trusting it. The shape of what the run leaves behind is ADR 0253's
 * (`../wire/eval-record.ts`).
 *
 * This module is **pure**: the executions arrive through the {@link RunOnce} seam, so the unit tier
 * drives the whole protocol against a stubbed grader and no unit test spends a cent.
 */
import {Effect} from "effect";
import {
	dispersionOf,
	type EvalCaseBlock,
	type EvalRecord,
	type EvalRecordCell,
	type EvalRecordPins,
	recordedAt as makeRecordedAt,
	roundRate,
} from "../wire/eval-record.ts";
import {headSha, clause as makeClause} from "../wire/verdict-marker.ts";
import type {AssertionOutcome, EvalRow} from "./deterministic-tier.ts";
import type {ScorecardCell} from "./report.ts";
import {decodeHeadlessResult, type ExecutorResult} from "./spawn.ts";

/** Founder ruling 4 on #4637: five runs and take the median for a judgment eval. */
export const GRADED_RUNS = 5;

/**
 * Why a grader invocation produced no verdict (ADR 0253 §4).
 *
 * Four rather than one because they are four different repairs: a grader that answered nothing, one
 * whose answer could not be read, one that never came back, and one that never ran.
 */
export const NO_VERDICT_REASONS = [
	"no-output",
	"unparseable",
	"timed-out",
	"invocation-failed",
] as const;

export type NoVerdictReason = (typeof NO_VERDICT_REASONS)[number];

/** One run's answer. `NoVerdict` is a typed outcome, never an absent value and never a pass. */
export type RunVerdict =
	| {readonly _tag: "Verdict"; readonly passed: boolean}
	| {readonly _tag: "NoVerdict"; readonly reason: NoVerdictReason};

/** What the grader invocation produced, as a value — the shape {@link readGraderVerdict} judges. */
export type GraderResponse =
	| {readonly _tag: "Returned"; readonly text: string}
	| {readonly _tag: "TimedOut"}
	| {readonly _tag: "InvocationFailed"; readonly detail: string};

/** The one line the grader is asked to end on. Reading it is not a rubric — the rubric is authored. */
const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|FAIL)\s*$/i;

/**
 * Read a grader response into a run verdict. Total, and never defaults to a pass.
 *
 * The last conforming line wins: a grader that reasons aloud before answering mentions `PASS` and
 * `FAIL` on the way, so the first match is the wrong one to trust.
 */
export const readGraderVerdict = (response: GraderResponse): RunVerdict => {
	if (response._tag === "TimedOut") return {_tag: "NoVerdict", reason: "timed-out"};
	if (response._tag === "InvocationFailed") {
		return {_tag: "NoVerdict", reason: "invocation-failed"};
	}
	if (response.text.trim() === "") return {_tag: "NoVerdict", reason: "no-output"};
	const lines = response.text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const matched = VERDICT_LINE.exec(lines[i] ?? "");
		if (matched?.[1] !== undefined) {
			return {_tag: "Verdict", passed: matched[1].toUpperCase() === "PASS"};
		}
	}
	return {_tag: "NoVerdict", reason: "unparseable"};
};

/**
 * What the executor observed, read as a grader response.
 *
 * The mapping is the whole reason the four `NoVerdict` reasons are four: a wedged grader, one that
 * never started, and one that answered nothing are three different repairs, and the executor already
 * tells them apart. Folding them here would throw that away at the last step.
 */
export const graderResponseOf = (result: ExecutorResult): GraderResponse => {
	if (result._tag === "TimedOut") return {_tag: "TimedOut"};
	if (result._tag === "SpawnFailed") return {_tag: "InvocationFailed", detail: result.detail};
	const decoded = decodeHeadlessResult(result.stdout);
	// An undecodable payload is not silence: the invocation returned bytes nobody can read, which is
	// `unparseable` once `readGraderVerdict` looks for a verdict line in them.
	return {_tag: "Returned", text: decoded === null ? result.stdout : decoded.text};
};

/**
 * The candidate run's output, or why the run produced none.
 *
 * A candidate that died is a run with no verdict for the *same* reason a dead grader is: nothing was
 * judged. Scoring it as a fail would blame the skill for the harness (ADR 0253 §4).
 */
export const candidateOutputOf = (
	result: ExecutorResult,
): {readonly _tag: "Output"; readonly text: string} | RunVerdict => {
	if (result._tag === "TimedOut") return {_tag: "NoVerdict", reason: "timed-out"};
	if (result._tag === "SpawnFailed") return {_tag: "NoVerdict", reason: "invocation-failed"};
	const text = decodeHeadlessResult(result.stdout)?.text ?? "";
	return text.trim() === "" ? {_tag: "NoVerdict", reason: "no-output"} : {_tag: "Output", text};
};

/** One run's token as the eval record carries it, in run order. */
export const perRunToken = (verdict: RunVerdict): string =>
	verdict._tag === "Verdict" ? (verdict.passed ? "pass" : "fail") : `no-verdict:${verdict.reason}`;

/**
 * The case a graded run is driven from — read structurally, so this module adds no field to the
 * authored `/skill-creator` format and depends on none of the ingestion module's other fields.
 */
export interface GradableCase {
	readonly id: number;
	readonly prompt: string;
	/** The authored `expected_output`, verbatim. `null` when the case declares none. */
	readonly expectedOutput: string | null;
	/** The authored judgment assertions, verbatim. This is the rubric, and the only one. */
	readonly expectations: ReadonlyArray<string>;
	/**
	 * The authored `files` — the fixture material this case needs, and the whole of what a run's
	 * working directory is staged with (`./run-workspace.ts`, #5434/#5437).
	 */
	readonly files: ReadonlyArray<string>;
}

/**
 * A decoded eval case as this module reads it: the authored prompt, expected output and assertion
 * texts, and nothing else. Every assertion is handed to the grader — a graded case's mechanical
 * assertions are part of the standard its author wrote, not a separate tier to drop here.
 */
export const gradableCase = (evalCase: {
	readonly id: number;
	readonly prompt: string;
	readonly expectedOutput: string | null;
	readonly files: ReadonlyArray<string>;
	readonly assertions: ReadonlyArray<{readonly text: string}>;
}): GradableCase => ({
	id: evalCase.id,
	prompt: evalCase.prompt,
	expectedOutput: evalCase.expectedOutput,
	expectations: evalCase.assertions.map((assertion) => assertion.text),
	files: evalCase.files,
});

/**
 * The fixed instructions {@link composeGraderPrompt} adds around the authored text.
 *
 * Exported so a test can assert that everything *else* in a composed prompt came from the case: the
 * "no second rubric" property is checkable rather than asserted, which is what keeps a future edit
 * from smuggling a criterion in here.
 */
export const GRADER_INSTRUCTIONS = [
	"You are grading one eval case. The expectations below were written by the skill's authoring",
	"session and are the whole standard — apply them as written, add none of your own, and drop none.",
	"Answer on a final line of exactly `VERDICT: PASS` or `VERDICT: FAIL`, and nothing after it.",
] as const;

const section = (heading: string, body: string): string => `## ${heading}\n${body}`;

/** Compose the grader's prompt: the fixed instructions, then the case's own authored text. */
export const composeGraderPrompt = (args: {
	readonly evalCase: GradableCase;
	readonly candidateOutput: string;
}): string => {
	const {evalCase, candidateOutput} = args;
	return [
		GRADER_INSTRUCTIONS.join("\n"),
		"",
		section("Prompt the skill was given", evalCase.prompt),
		"",
		section("What the skill produced", candidateOutput),
		...(evalCase.expectedOutput === null
			? []
			: ["", section("Expected output, as authored", evalCase.expectedOutput)]),
		"",
		section(
			"Expectations, as authored",
			evalCase.expectations.map((text) => `- ${text}`).join("\n"),
		),
	].join("\n");
};

/** A case's median verdict. `unmeasured` is the case whose every run returned no verdict. */
export type CaseVerdict = "pass" | "fail" | "unmeasured";

/** One graded case's five runs, retained rather than collapsed into the median (#4678). */
export interface GradedCaseResult {
	readonly caseId: number;
	readonly verdict: CaseVerdict;
	readonly runs: number;
	readonly passed: number;
	readonly noVerdict: number;
	readonly dispersion: number;
	readonly perRun: ReadonlyArray<string>;
}

/**
 * The median over an odd or even set of binary verdicts, with a `NoVerdict` on the non-pass side.
 *
 * Sorting `fail < pass` and taking the **lower** middle element is what makes an even split resolve
 * to `fail`: a set that is half failing has not shown the case passes, and the alternative — rounding
 * a tie up — would be the median quietly defaulting to a pass, which is the direction this whole
 * module refuses. At the ruled five runs the tie never arises; the rule is stated because the
 * function is total over any run count.
 */
export const medianVerdict = (verdicts: ReadonlyArray<RunVerdict>): CaseVerdict => {
	if (verdicts.length === 0) return "unmeasured";
	if (verdicts.every((verdict) => verdict._tag === "NoVerdict")) return "unmeasured";
	const passed = verdicts.filter((verdict) => verdict._tag === "Verdict" && verdict.passed).length;
	// The lower middle index of the sorted set: with `fail` sorting first, the element at
	// `floor((n-1)/2)` is `pass` exactly when the passes fill the upper half and one more.
	return passed > Math.floor(verdicts.length / 2) ? "pass" : "fail";
};

/** Fold one case's runs into its retained result — the median plus everything the median throws away. */
export const gradeCase = (
	caseId: number,
	verdicts: ReadonlyArray<RunVerdict>,
): GradedCaseResult => {
	const passed = verdicts.filter((verdict) => verdict._tag === "Verdict" && verdict.passed).length;
	const noVerdict = verdicts.filter((verdict) => verdict._tag === "NoVerdict").length;
	return {
		caseId,
		verdict: medianVerdict(verdicts),
		runs: verdicts.length,
		passed,
		noVerdict,
		dispersion: dispersionOf(verdicts.length, passed),
		perRun: verdicts.map(perRunToken),
	};
};

/**
 * Execute one run of one case and judge it. The module's only seam, and the only path to a model.
 *
 * `R` is the platform requirement the *implementation* carries — the spawning shell's services, or
 * `never` for a stub — so this core names no platform service and a unit test drives the whole
 * protocol offline.
 */
export type RunOnce<R = never> = (args: {
	readonly evalCase: GradableCase;
	/** 1-based, so a log or a stub can name which of the five it is. */
	readonly run: number;
}) => Effect.Effect<RunVerdict, never, R>;

/**
 * Run every case `runs` times and fold each into its median.
 *
 * **A `NoVerdict` is never retried inside the block.** A retry replaces a measurement with a
 * re-measurement and silently changes what the median measured, so the count is fixed and a dead
 * invocation is carried into the record instead (ADR 0253 §4). Any retry policy belongs around the
 * whole five-run block, recorded as such.
 */
export const runGradedAxis = <R>(args: {
	readonly cases: ReadonlyArray<GradableCase>;
	readonly runOnce: RunOnce<R>;
	readonly runs?: number;
}): Effect.Effect<ReadonlyArray<GradedCaseResult>, never, R> =>
	Effect.gen(function* () {
		const runs = args.runs ?? GRADED_RUNS;
		const results: Array<GradedCaseResult> = [];
		for (const evalCase of args.cases) {
			const verdicts: Array<RunVerdict> = [];
			for (let run = 1; run <= runs; run += 1) {
				verdicts.push(yield* args.runOnce({evalCase, run}));
			}
			results.push(gradeCase(evalCase.id, verdicts));
		}
		return results;
	});

/**
 * A graded case as an `EvalRow`, so graded rows fold through `summarizeEvalRows` — **the** aggregator
 * both tiers share — rather than through a second path.
 *
 * The grader answers per case, not per assertion, so every judged assertion carries the case's own
 * verdict and says so on a non-pass. Inventing a per-assertion answer the grader never gave would be
 * exactly the fabricated detail the eval layer exists to keep out.
 */
export const toEvalRow = (result: GradedCaseResult, evalCase: GradableCase): EvalRow => {
	const outcome =
		result.verdict === "pass" ? "pass" : result.verdict === "fail" ? "fail" : "uncheckable";
	const detail =
		result.verdict === "pass"
			? null
			: result.verdict === "fail"
				? `the median of ${result.runs} run(s) is fail (${result.passed} passed, ${result.noVerdict} returned no verdict)`
				: `every one of ${result.runs} run(s) returned no verdict (${result.perRun.join(", ")})`;
	const assertions: ReadonlyArray<AssertionOutcome> = evalCase.expectations.map((text) => ({
		text,
		cue: null,
		status: outcome === "pass" ? "pass" : outcome === "fail" ? "fail" : "uncheckable",
		detail: outcome === "pass" ? null : detail,
	}));
	return {caseId: result.caseId, tier: "graded", outcome, runs: result.runs, assertions, detail};
};

/**
 * The cell aggregate, spelled as `ScorecardCell` so #4680 commits a scorecard row without renaming
 * anything (ADR 0253 §5). One graded **case** is one graded run at cell level; the five executions
 * behind it live in the case block.
 *
 * An `unmeasured` case is absent from both sides. It measured nothing, so counting it as a failure
 * would publish a number nobody took — the `0.0`-over-no-measurement the record's `UNRECORDABLE`
 * token exists to keep distinguishable (ADR 0253 §2).
 */
export const gradedCellAggregate = (
	results: ReadonlyArray<GradedCaseResult>,
): Pick<ScorecardCell, "gradedRuns" | "passedRuns" | "passRate"> => {
	const graded = results.filter((result) => result.verdict !== "unmeasured");
	const passedRuns = graded.filter((result) => result.verdict === "pass").length;
	return {
		gradedRuns: graded.length,
		passedRuns,
		passRate: graded.length === 0 ? 0 : roundRate(passedRuns / graded.length),
	};
};

const caseBlock = (result: GradedCaseResult): EvalCaseBlock => ({
	caseId: result.caseId,
	verdict: result.verdict,
	runs: result.runs,
	passed: result.passed,
	noVerdict: result.noVerdict,
	dispersion: result.dispersion,
	perRun: result.perRun,
});

export type EvalRecordBuild =
	| {readonly _tag: "Record"; readonly record: EvalRecord}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Build the head-bound eval record for one cell's graded results.
 *
 * **A record is produced on every outcome.** A below-bar run records its below-bar number, and a run
 * where nothing could be measured records `UNRECORDABLE` — because a failing run that wrote nothing
 * would reach the verifier as `missing`, reddening for the wrong reason and destroying the number
 * #4680's trend reads. `missing`, `stale`, `below-bar` and `unrecordable` stay four distinguishable
 * states, and none of them is judged here: the 90% bar is #4681's and appears nowhere in this module.
 *
 * That extends to the runs that never reached a case: an eval set that could not be read, one that
 * does not conform, and one carrying no graded case each record `UNRECORDABLE` naming *which* of
 * them it was, via `noMeasurement` (founder ruling, #4678 comment 5247447078 — explicit beats
 * implicit for error cases). Silence there would reach #4681 as `missing`, indistinguishable from a
 * review that never ran the axis at all.
 */
export const buildEvalRecord = (args: {
	readonly sha: string;
	readonly recordedAt: string;
	readonly cell: EvalRecordCell;
	readonly pins: EvalRecordPins;
	readonly results: ReadonlyArray<GradedCaseResult>;
	/** Why nothing was measured, when the axis never reached a case. Only read on `UNRECORDABLE`. */
	readonly noMeasurement?: string;
}): EvalRecordBuild => {
	const sha = headSha(args.sha);
	if (sha === null) {
		return {
			_tag: "Unusable",
			reason: `"${args.sha}" is not a head SHA — an unbound measurement attests no tree`,
		};
	}
	const at = makeRecordedAt(args.recordedAt);
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${args.recordedAt}" is not an ISO-8601 UTC instant with a trailing Z`,
		};
	}
	const aggregate = gradedCellAggregate(args.results);
	const unmeasured = args.results.length - aggregate.gradedRuns;
	const surface = args.cell.surface === null ? "—" : args.cell.surface;
	const outcome = aggregate.gradedRuns === 0 ? "UNRECORDABLE" : "RECORDED";
	const text = makeClause(
		outcome === "RECORDED"
			? `${args.cell.stage}/${surface} ${aggregate.passRate} (${aggregate.passedRuns}/${aggregate.gradedRuns} cases, ${unmeasured} unmeasured)`
			: `${args.cell.stage}/${surface} no measurement — ${args.noMeasurement ?? `${unmeasured} case(s) returned no verdict`}`,
	);
	if (text === null) {
		// Unreachable: every branch above composes a non-blank clause from literals.
		return {_tag: "Unusable", reason: "the composed clause is blank"};
	}
	return {
		_tag: "Record",
		record: {
			outcome,
			sha,
			clause: text,
			payload: {
				sha,
				recordedAt: at,
				cell: args.cell,
				pins: args.pins,
				...aggregate,
				unmeasuredCases: unmeasured,
				cases: args.results.map(caseBlock),
			},
		},
	};
};
