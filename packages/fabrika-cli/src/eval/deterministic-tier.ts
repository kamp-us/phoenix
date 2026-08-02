/**
 * The eval deterministic tier — the no-model half of the fabrika eval layer (issue #4677,
 * epic #4649).
 *
 * A case whose assertions are all mechanically checkable never needs a model: it runs its
 * CLI-layer command **once**, and its assertions are read straight off what that run produced.
 * This module owns that judgement, the one-run protocol (`reconcileRerun`), and `EvalRow` — the
 * row shape the graded tier (#4678) reports in too, so one aggregator serves both.
 *
 * The tier holds no IO of its own: `resolveCommand` and `observe` are supplied by the caller, so
 * the only IO is the caller's. That is what makes "no model in the loop" *checkable* rather than
 * asserted — this file imports nothing but `effect` itself, so it can reach nothing spawnable, and
 * `deferGraded` is its only handoff toward a model-bearing path.
 *
 * The case shape it consumes is #4674's decoded `SkillEvalCase` (`skill-eval-set.ts`), read
 * structurally so this tier re-derives no parser and adds no field to the authored format.
 */
import {Effect} from "effect";

/**
 * The two tiers a decoded case routes to. Same two values #4674's derived `EvalTier` yields;
 * named separately here so the row shape does not depend on the ingestion module's type.
 */
export type EvalRowTier = "deterministic" | "graded";

/**
 * A decoded assertion, read structurally: #4674's `SkillEvalAssertion` satisfies this, and `cue`
 * is widened to `string` so this tier never restates that module's cue lexicon.
 */
export type TieredAssertion =
	| {readonly kind: "mechanical"; readonly text: string; readonly cue: string}
	| {readonly kind: "judgment"; readonly text: string};

/** A decoded eval case, read structurally — the fields this tier actually reads, and no more. */
export interface TieredEvalCase {
	readonly id: number;
	readonly tier: EvalRowTier;
	readonly assertions: ReadonlyArray<TieredAssertion>;
}

/** The CLI-layer command one deterministic case runs. Not part of the authored eval format. */
export interface DeterministicCommand {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string | null;
	readonly timeoutMs: number | null;
}

/** What one CLI-layer run produced — the only thing a mechanical assertion is ever read against. */
export interface CliObservation {
	/** The exit status the run reported, or `null` when it was killed before reporting one. */
	readonly exitStatus: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** Of the paths the case's `file-artifact` assertions name, the ones present after the run. */
	readonly artifacts: ReadonlyArray<string>;
	/** Tools the run was seen to invoke, or `null` when this observer cannot see them at all. */
	readonly toolInvocations: ReadonlyArray<string> | null;
	/**
	 * Why the command never started, or `null` when it ran. A did-not-run is UNKNOWN, so it must
	 * be distinguishable from a run that answered — never collapsed into a failing exit status.
	 */
	readonly notRun: string | null;
}

/**
 * One assertion's outcome. Deliberately flat and tier-agnostic: the graded tier (#4678) reports
 * judged assertions in this same shape with `cue: null`, so there is one row model, not two.
 */
export interface AssertionOutcome {
	readonly text: string;
	/** The mechanical cue checked, or `null` for a judged assertion. */
	readonly cue: string | null;
	readonly status: "pass" | "fail" | "uncheckable";
	/** Why it is not a pass — `null` on a pass. */
	readonly detail: string | null;
}

/**
 * A case's outcome. Everything that is not `pass` is a failure of the suite: `uncheckable` and
 * `flake` are defects *of the case* (or of the CLI it exercises) and are reported as such, but
 * neither is ever tolerated into green.
 */
export type EvalRowOutcome = "pass" | "fail" | "uncheckable" | "flake";

/**
 * One eval case's result — the single row shape **both** tiers emit, so the report path
 * aggregates them through one aggregation function (`summarizeEvalRows`) rather than two.
 */
export interface EvalRow {
	readonly caseId: number;
	readonly tier: EvalRowTier;
	readonly outcome: EvalRowOutcome;
	/** Executions behind this row. Deterministic is always `1` — the tier never retries. */
	readonly runs: number;
	readonly assertions: ReadonlyArray<AssertionOutcome>;
	/** Why the row is not a pass — `null` on a pass. */
	readonly detail: string | null;
}

/** What a mechanical assertion's prose was read to mean, or why it could not be read. */
export type Expectation =
	| {readonly _tag: "ExitStatus"; readonly code: number}
	| {readonly _tag: "ExitNonZero"}
	| {
			readonly _tag: "Substring";
			readonly stream: "stdout" | "stderr" | "any";
			readonly needle: string;
	  }
	| {readonly _tag: "FileExists"; readonly path: string}
	| {readonly _tag: "ToolInvoked"; readonly tool: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The first quoted run in an assertion's text — the literal the assertion is about. Backticks,
 * straight quotes and typographic quotes all count, because assertions are authored as prose by
 * a human and a smart-quoted path is the same path.
 */
const QUOTED = /[`"'‘“]([^`"'’”]+)[`"'’”]/;

const quoted = (text: string): string | null => QUOTED.exec(text)?.[1]?.trim() || null;

const EXIT_NON_ZERO = /\bnon-?zero\b/i;
const EXIT_CODE = /\bexit(?:s|ed)?(?:\s+(?:code|status))?\s*(?:is|of|was|=|==|:)?\s*(\d+)\b/i;

/**
 * Read one mechanical assertion's prose into a concrete expectation.
 *
 * Deliberately literal and narrow rather than a general parser: every shape it cannot read
 * becomes `Unreadable`, which reds the case as a defect. That direction is the whole point —
 * a permissive reader that guessed an expectation would report a green nobody earned, whereas
 * an `Unreadable` costs a one-line edit to the case.
 */
export const readExpectation = (assertion: TieredAssertion): Expectation => {
	if (assertion.kind === "judgment") {
		return {
			_tag: "Unreadable",
			reason: "judgment assertion on a deterministic case — it belongs on the graded tier",
		};
	}
	const text = assertion.text;
	switch (assertion.cue) {
		case "exit-status": {
			if (EXIT_NON_ZERO.test(text)) return {_tag: "ExitNonZero"};
			const code = EXIT_CODE.exec(text)?.[1];
			return code === undefined
				? {_tag: "Unreadable", reason: "names no expected exit code"}
				: {_tag: "ExitStatus", code: Number(code)};
		}
		case "output-content": {
			const needle = quoted(text);
			if (needle === null) return {_tag: "Unreadable", reason: "names no quoted expected output"};
			const lowered = text.toLowerCase();
			const stream = lowered.includes("stderr")
				? ("stderr" as const)
				: lowered.includes("stdout")
					? ("stdout" as const)
					: ("any" as const);
			return {_tag: "Substring", stream, needle};
		}
		case "file-artifact": {
			const path = quoted(text);
			return path === null
				? {_tag: "Unreadable", reason: "names no quoted file path"}
				: {_tag: "FileExists", path};
		}
		case "tool-invocation": {
			const tool = quoted(text);
			return tool === null
				? {_tag: "Unreadable", reason: "names no quoted tool"}
				: {_tag: "ToolInvoked", tool};
		}
		default:
			return {_tag: "Unreadable", reason: `unknown cue '${assertion.cue}'`};
	}
};

/** The file paths a case's `file-artifact` assertions name — what an observer must probe for. */
export const namedArtifactPaths = (evalCase: TieredEvalCase): ReadonlyArray<string> => {
	const paths: Array<string> = [];
	for (const assertion of evalCase.assertions) {
		const expectation = readExpectation(assertion);
		if (expectation._tag === "FileExists") paths.push(expectation.path);
	}
	return paths;
};

const pass = (assertion: TieredAssertion, cue: string | null): AssertionOutcome => ({
	text: assertion.text,
	cue,
	status: "pass",
	detail: null,
});

const fail = (
	assertion: TieredAssertion,
	cue: string | null,
	detail: string,
): AssertionOutcome => ({
	text: assertion.text,
	cue,
	status: "fail",
	detail,
});

const uncheckable = (
	assertion: TieredAssertion,
	cue: string | null,
	detail: string,
): AssertionOutcome => ({text: assertion.text, cue, status: "uncheckable", detail});

/** Check one mechanical assertion against a run's observation. Total — never throws. */
export const checkAssertion = (
	assertion: TieredAssertion,
	observation: CliObservation,
): AssertionOutcome => {
	const cue = assertion.kind === "mechanical" ? assertion.cue : null;
	const expectation = readExpectation(assertion);
	switch (expectation._tag) {
		case "Unreadable":
			return uncheckable(assertion, cue, expectation.reason);
		case "ExitStatus":
			if (observation.exitStatus === null) {
				return fail(assertion, cue, "the run was killed before it reported an exit status");
			}
			return observation.exitStatus === expectation.code
				? pass(assertion, cue)
				: fail(
						assertion,
						cue,
						`exit status was ${observation.exitStatus}, expected ${expectation.code}`,
					);
		case "ExitNonZero":
			if (observation.exitStatus === null) {
				return fail(assertion, cue, "the run was killed before it reported an exit status");
			}
			return observation.exitStatus !== 0
				? pass(assertion, cue)
				: fail(assertion, cue, "exit status was 0, expected non-zero");
		case "Substring": {
			const haystack =
				expectation.stream === "stdout"
					? observation.stdout
					: expectation.stream === "stderr"
						? observation.stderr
						: `${observation.stdout}\n${observation.stderr}`;
			return haystack.includes(expectation.needle)
				? pass(assertion, cue)
				: fail(assertion, cue, `${expectation.stream} does not contain '${expectation.needle}'`);
		}
		case "FileExists":
			return observation.artifacts.includes(expectation.path)
				? pass(assertion, cue)
				: fail(assertion, cue, `no file at '${expectation.path}' after the run`);
		case "ToolInvoked":
			// An observer that cannot see tool invocations at all has not answered "it wasn't
			// invoked" — that is UNKNOWN, so the case reds as a defect rather than a false fail.
			if (observation.toolInvocations === null) {
				return uncheckable(
					assertion,
					cue,
					"this observer cannot see tool invocations — the case needs a transcript-backed one",
				);
			}
			return observation.toolInvocations.includes(expectation.tool)
				? pass(assertion, cue)
				: fail(assertion, cue, `the run did not invoke '${expectation.tool}'`);
	}
};

const rowOutcome = (assertions: ReadonlyArray<AssertionOutcome>): EvalRowOutcome => {
	if (assertions.some((a) => a.status === "uncheckable")) return "uncheckable";
	return assertions.some((a) => a.status === "fail") ? "fail" : "pass";
};

const firstDetail = (
	assertions: ReadonlyArray<AssertionOutcome>,
	status: AssertionOutcome["status"],
): string | null => assertions.find((a) => a.status === status)?.detail ?? null;

/**
 * Judge one deterministic case from a single run's observation. Pure and total: this is the whole
 * verdict for the case, and it is reached in exactly one execution.
 */
export const judgeDeterministicCase = (
	evalCase: TieredEvalCase,
	observation: CliObservation,
): EvalRow => {
	const base = {caseId: evalCase.id, tier: "deterministic" as const, runs: 1};
	if (observation.notRun !== null) {
		return {
			...base,
			outcome: "uncheckable",
			assertions: [],
			detail: `the case's command never ran (${observation.notRun})`,
		};
	}
	if (evalCase.assertions.length === 0) {
		return {
			...base,
			outcome: "uncheckable",
			assertions: [],
			detail: "the case carries no assertions — there is nothing to check",
		};
	}
	const assertions = evalCase.assertions.map((a) => checkAssertion(a, observation));
	const outcome = rowOutcome(assertions);
	return {
		...base,
		outcome,
		assertions,
		detail:
			outcome === "pass"
				? null
				: firstDetail(assertions, outcome === "fail" ? "fail" : "uncheckable"),
	};
};

/** Resolves the CLI-layer command a case runs, or `null` when the case declares none. */
export type CommandResolver = (evalCase: TieredEvalCase) => DeterministicCommand | null;

/**
 * Runs one case's command and reports what it produced. The caller's only IO seam.
 *
 * `R` is the platform requirement the *implementation* carries — the shell observer's services, or
 * `never` for a stub — so this tier still names no platform service and can reach nothing spawnable.
 */
export type CaseObserver<R = never> = (
	evalCase: TieredEvalCase,
	command: DeterministicCommand,
) => Effect.Effect<CliObservation, never, R>;

/** What one pass over a set produced: a row per deterministic case, and the graded ids it routed away. */
export interface DeterministicTierRun {
	readonly rows: ReadonlyArray<EvalRow>;
	readonly deferredToGraded: ReadonlyArray<number>;
}

/**
 * Route a decoded set by tier and execute the deterministic half — each case exactly once.
 *
 * `deferGraded` is the handoff to #4678's model-bearing path and is the only seam in this module
 * through which a model could ever be reached. It is called for graded cases and **never** for a
 * deterministic one, which is what a caller (or a test) asserts against to prove no model entered
 * the loop.
 */
export const runDeterministicTier = <R>(args: {
	readonly cases: ReadonlyArray<TieredEvalCase>;
	readonly resolveCommand: CommandResolver;
	readonly observe: CaseObserver<R>;
	readonly deferGraded?: (evalCase: TieredEvalCase) => void;
}): Effect.Effect<DeterministicTierRun, never, R> =>
	Effect.gen(function* () {
		const rows: Array<EvalRow> = [];
		const deferredToGraded: Array<number> = [];
		for (const evalCase of args.cases) {
			if (evalCase.tier !== "deterministic") {
				deferredToGraded.push(evalCase.id);
				args.deferGraded?.(evalCase);
				continue;
			}
			const command = args.resolveCommand(evalCase);
			if (command === null) {
				rows.push({
					caseId: evalCase.id,
					tier: "deterministic",
					outcome: "uncheckable",
					runs: 0,
					assertions: [],
					detail: "the case declares no CLI-layer command to run",
				});
				continue;
			}
			rows.push(judgeDeterministicCase(evalCase, yield* args.observe(evalCase, command)));
		}
		return {rows, deferredToGraded};
	});

/** A deterministic case that did not reproduce — a defect of the case, routed like any other bug. */
export interface FlakeDefect {
	readonly caseId: number;
	readonly firstOutcome: EvalRowOutcome;
	readonly rerunOutcome: EvalRowOutcome;
	/** A one-line body for the `report` path — the flake stance as a mechanism, not a slogan. */
	readonly summary: string;
}

const assertionShape = (row: EvalRow): string =>
	row.assertions.map((a) => `${a.cue ?? "judged"}:${a.status}`).join("|");

/**
 * Reconcile a deliberate re-run against the first run.
 *
 * This is **not** a retry and can never turn a fail into a pass: an agreeing re-run returns the
 * first row untouched (`runs` stays 1 — the verdict came from one execution), and a disagreeing
 * one returns a `flake` row plus a defect to file. Non-reproduction is a bug in the case or in the
 * CLI it exercises, so it is surfaced, never quarantined and never retried into green.
 */
export const reconcileRerun = (
	first: EvalRow,
	rerun: EvalRow,
): {readonly row: EvalRow; readonly defect: FlakeDefect | null} => {
	const agrees = first.outcome === rerun.outcome && assertionShape(first) === assertionShape(rerun);
	if (agrees) return {row: first, defect: null};
	const summary =
		`deterministic eval case ${first.caseId} did not reproduce: the first run was ` +
		`'${first.outcome}', an identical re-run was '${rerun.outcome}'. A deterministic case that ` +
		"does not reproduce is a defect of the case or of the CLI it exercises — file it, never retry it.";
	return {
		row: {
			caseId: first.caseId,
			tier: first.tier,
			outcome: "flake",
			runs: 2,
			assertions: first.assertions,
			detail: summary,
		},
		defect: {
			caseId: first.caseId,
			firstOutcome: first.outcome,
			rerunOutcome: rerun.outcome,
			summary,
		},
	};
};

/** Per-tier tallies over eval rows. */
export interface TierCounts {
	readonly cases: number;
	readonly passed: number;
	readonly failed: number;
	readonly uncheckable: number;
	readonly flaked: number;
}

/** The aggregate over a suite's rows — one shape, both tiers. */
export interface EvalSuiteSummary {
	readonly total: TierCounts;
	readonly byTier: Record<EvalRowTier, TierCounts>;
	readonly passRate: number;
	readonly verdict: "green" | "red";
	/** Why the suite is red — `null` on green. */
	readonly redReason: string | null;
}

const emptyCounts = (): TierCounts => ({cases: 0, passed: 0, failed: 0, uncheckable: 0, flaked: 0});

const tally = (counts: TierCounts, outcome: EvalRowOutcome): TierCounts => ({
	cases: counts.cases + 1,
	passed: counts.passed + (outcome === "pass" ? 1 : 0),
	failed: counts.failed + (outcome === "fail" ? 1 : 0),
	uncheckable: counts.uncheckable + (outcome === "uncheckable" ? 1 : 0),
	flaked: counts.flaked + (outcome === "flake" ? 1 : 0),
});

/**
 * Aggregate eval rows into a suite verdict. **The one aggregation path** — the graded tier's rows
 * are the same shape, so they fold in here rather than through a second aggregator.
 *
 * Zero rows is RED, not a vacuous green (ADR 0092): a suite that could not see its own corpus has
 * proven nothing, and this repo has repeatedly shipped guards that passed because of exactly that.
 */
export const summarizeEvalRows = (rows: ReadonlyArray<EvalRow>): EvalSuiteSummary => {
	let total = emptyCounts();
	const byTier: Record<EvalRowTier, TierCounts> = {
		deterministic: emptyCounts(),
		graded: emptyCounts(),
	};
	for (const row of rows) {
		total = tally(total, row.outcome);
		byTier[row.tier] = tally(byTier[row.tier], row.outcome);
	}
	if (total.cases === 0) {
		return {
			total,
			byTier,
			passRate: 0,
			verdict: "red",
			redReason:
				"zero scope: no eval rows — a suite that checked nothing is never green (ADR 0092)",
		};
	}
	const passRate = total.passed / total.cases;
	const notPassed = total.cases - total.passed;
	return {
		total,
		byTier,
		passRate,
		verdict: notPassed === 0 ? "green" : "red",
		redReason:
			notPassed === 0
				? null
				: `${notPassed} of ${total.cases} cases did not pass ` +
					`(${total.failed} failed, ${total.uncheckable} uncheckable, ${total.flaked} flaked)`,
	};
};
