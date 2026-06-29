/**
 * The pure orchestration core of the on-demand rite-audit run (#1517, epic #1510 capstone):
 * the single-entry "run a rite-audit now" that wires the stage lifecycle (#1512), the
 * agentic explorer (#1513–#1515), and the verdict report (#1516) into one invocation —
 * provision → walk all dimensions → emit + archive the dated verdict → ALWAYS destroy the
 * stage → surface the per-dimension verdict.
 *
 * The agentic-explorer invocation is the load-bearing design nuance. The rite-audit explorer
 * is an LLM driving the Playwright MCP, NOT a plain function — so it cannot be a trivial
 * programmatic call from a TS process. It is therefore the **injected walk seam**
 * ({@link AuditWalk}), exactly the shape #1512's `runHook` was built as: the operator/agent
 * supplies the actual agentic walk (the real adapter shells out to an operator-supplied walk
 * command — never a faked automated LLM call), and this core owns everything around it. The
 * unit test injects a fake walk, so the safety property is proven with no real deploy/agent.
 *
 * The guaranteed-teardown is REUSED, not re-derived: this core plugs its
 * walk→buildVerdict→archive into #1512's `runStageLifecycle` as the `runHook`, so #1512's
 * `Effect.onExit(destroy)` wraps WHATEVER the run-hook is — a walk that crashes mid-run AND an
 * archive that fails still tear the stage down (story 10: no flag-on stage is ever left alive).
 * Placing buildVerdict + archive inside the run-hook keeps the spec order (walk → archive →
 * destroy): the archive lands while the lifecycle body runs, before the onExit teardown.
 */
import {
	type AuditRunInput,
	runStageLifecycle,
	StageLifecycleError,
	type StageLifecyclePort,
} from "@kampus/audit-stage";
import {buildVerdict, type DimensionResult, type Verdict} from "@kampus/audit-verdict";
import {Effect, Option, Ref} from "effect";

/**
 * The agentic-explorer seam (#1513). Given the live stage's run context, walk every
 * dimension and resolve their `DimensionResult`s. The real implementation runs the agentic
 * rite-audit skill out-of-process (see `adapter.ts`); the unit test injects a fake. A walk
 * that cannot complete fails in the `StageLifecycleError` (`run-hook` phase) channel so the
 * lifecycle's guaranteed teardown still fires.
 */
export type AuditWalk = (
	input: AuditRunInput,
) => Effect.Effect<ReadonlyArray<DimensionResult>, StageLifecycleError>;

/** Where a verdict was archived — the repo-relative JSON + Markdown run-log paths (#1516). */
export interface ArchivedVerdict {
	readonly jsonPath: string;
	readonly mdPath: string;
}

/** Persist one dated verdict to the repo-relative run log (#1516); a write failure surfaces in-channel so teardown still runs. */
export type AuditArchiver = (
	verdict: Verdict,
) => Effect.Effect<ArchivedVerdict, StageLifecycleError>;

/** The injected seams the run is parameterized over — the real wiring lives in `adapter.ts`, the fakes in the unit test. */
export interface AuditRunDeps {
	/** The #1512 stage lifecycle port (its `runHook` is overridden by this core's walk seam). */
	readonly port: StageLifecyclePort;
	/** The agentic explorer walk (#1513). */
	readonly walk: AuditWalk;
	/** The dated-verdict archiver (#1516). */
	readonly archive: AuditArchiver;
	/** The run timestamp source — injected so the unit test is deterministic. */
	readonly now: () => string;
}

/** What a completed on-demand run returns — the surfaced verdict + where it was archived (the stage is already torn down). */
export interface AuditRunResult {
	readonly stage: string;
	readonly baseUrl: string;
	readonly verdict: Verdict;
	readonly archived: ArchivedVerdict;
}

/**
 * Run one complete on-demand rite-audit for `stage`, with teardown guaranteed on every exit.
 *
 * The walk → buildVerdict → archive sequence is installed as the lifecycle's `runHook`, so
 * #1512's `Effect.onExit(destroy)` tears the stage down whether the walk succeeded, the walk
 * crashed, or the archive failed. The verdict is captured into a `Ref` inside the run-hook and
 * read back after the lifecycle resolves — present exactly when the lifecycle ran past the
 * run-hook phase (a successful or FAIL-verdict walk); a crash never reaches this read.
 */
export const runAuditOnce = (
	deps: AuditRunDeps,
	stage: string,
): Effect.Effect<AuditRunResult, StageLifecycleError> =>
	Effect.gen(function* () {
		const captured = yield* Ref.make<Option.Option<{verdict: Verdict; archived: ArchivedVerdict}>>(
			Option.none(),
		);
		const port: StageLifecyclePort = {
			...deps.port,
			runHook: (input) =>
				deps.walk(input).pipe(
					Effect.flatMap((dimensions) => {
						const verdict = buildVerdict({
							date: deps.now(),
							target: {stage: input.stage, baseUrl: input.baseUrl},
							dimensions,
						});
						return deps
							.archive(verdict)
							.pipe(
								Effect.flatMap((archived) => Ref.set(captured, Option.some({verdict, archived}))),
							);
					}),
				),
		};
		const lifecycle = yield* runStageLifecycle(port, stage);
		const recorded = yield* Ref.get(captured);
		const {verdict, archived} = yield* Option.match(recorded, {
			onNone: () =>
				Effect.fail(
					new StageLifecycleError({
						phase: "run-hook",
						message:
							"lifecycle completed but no verdict was captured — the run-hook seam recorded none",
					}),
				),
			onSome: (v) => Effect.succeed(v),
		});
		return {stage, baseUrl: lifecycle.baseUrl, verdict, archived} satisfies AuditRunResult;
	});

/**
 * The operator-facing summary surfaced at the end of a run (acceptance #1517: surface the
 * run's overall verdict, per-dimension pass/fail). A pure string so the surfacing is unit
 * testable independent of the bin's Console.
 */
export const formatOperatorSummary = (result: AuditRunResult): string => {
	const lines: string[] = [];
	lines.push(`rite-audit: ${result.verdict.overall} — stage '${result.stage}' (${result.baseUrl})`);
	for (const d of result.verdict.perDimension) {
		lines.push(`  ${d.status}  ${d.dimension}`);
	}
	lines.push(`  archived: ${result.archived.jsonPath} + ${result.archived.mdPath}`);
	lines.push("  stage torn down (no live flag-on stage left behind).");
	return lines.join("\n");
};
