/**
 * The re-plan convergence loop with a stall-based circuit breaker (ADR 0047
 * Decision 3, issue #166).
 *
 * On a FAIL verdict from the gate (#164), the loop routes the epic back through
 * a re-plan and re-runs the gate; it repeats **while the hard-defect set strictly
 * shrinks**, and terminates with a clean PASS when defects reach zero. It trips
 * the circuit breaker — parking the epic at `status:needs-info` with a diagnostic
 * comment naming the stuck defects — when the `ledgerSignature` repeats (a cycle:
 * the same ledger came back) or the defect set fails to shrink (a stall:
 * re-planning stopped making progress). Convergence is the stop condition; a high
 * flat ceiling exists only as a runaway backstop, expressed as a `Schedule`.
 *
 * ## Schedule-based, not a fixed retry count
 *
 * The driver is `Effect.repeat(body, Schedule.recurs(ceiling) ∩ Schedule.while(…))`:
 * `Schedule.recurs(ceiling)` is the runaway backstop (the *only* fixed-count
 * element, and not the stop condition), and `Schedule.while` carries the real
 * stop — it continues only while the last pass was a still-shrinking FAIL. The
 * cross-iteration relation the stall test needs (this pass's defect set vs. the
 * last) lives in a `Ref` the body threads, because a `Schedule` step sees only
 * the current output, not the prior one.
 *
 * ## Why `plan-epic` is a capability, not a call
 *
 * `plan-epic` is a skill/agent, not a plain function this package can `import`.
 * The loop therefore depends on a `RePlanner` `Context.Service` — a one-method
 * seam (`rePlan(epicNumber)`) the *caller* satisfies with however it actually
 * re-invokes plan-epic (a subagent spawn, a queued job, a shell-out). The package
 * owns the convergence control flow and stays testable with a faked `RePlanner`;
 * the binding to the real agent lives at the call site, outside this package.
 * See `.claude/skills/review-plan/SKILL.md` for the agent-side wiring.
 */
import {Context, Effect, Ref, Schedule} from "effect";
import type * as Schema from "effect/Schema";
import type {Defect} from "./Defect.ts";
import {type GateVerdict, runGate} from "./gate.ts";
import {GhCommandError, type GhParseError, Github} from "./github.ts";

/** Everything the loop's effects can fail with: gate IO faults + a re-plan fault. */
type LoopError = GhCommandError | GhParseError | Schema.SchemaError | RePlanError;

/**
 * The re-plan seam. `rePlan(epicNumber)` re-invokes `plan-epic` on the epic and
 * resolves once the epic body + children have been re-written, so the next gate
 * pass reads the new ledger. `RePlanError` is its typed failure channel — a
 * caller's real re-plan mechanism surfaces its own failure as this tag without
 * this package naming the mechanism.
 */
export class RePlanError extends GhCommandError {}

export class RePlanner extends Context.Service<
	RePlanner,
	{
		readonly rePlan: (epicNumber: number) => Effect.Effect<void, RePlanError>;
	}
>()("@phoenix/epic-ledger/RePlanner") {}

/** Why the loop parked, beyond a clean pass. */
export type StallReason = "repeated-signature" | "non-shrinking" | "ceiling";

/**
 * The loop's terminal outcome. `"converged"` carries the flipped children (the
 * gate passed); `"parked"` carries the reason and the unresolved defects the
 * epic was parked on (`status:needs-info`).
 */
export type LoopOutcome =
	| {
			readonly _tag: "converged";
			readonly epicNumber: number;
			readonly flipped: ReadonlyArray<number>;
			readonly iterations: number;
	  }
	| {
			readonly _tag: "parked";
			readonly epicNumber: number;
			readonly reason: StallReason;
			readonly defects: ReadonlyArray<Defect>;
			readonly iterations: number;
	  };

/**
 * The runaway backstop ceiling for `Schedule.recurs`. High by design:
 * convergence or a stall should always fire first. This is the only fixed-count
 * element and it is *not* the stop condition (the stall tests are).
 */
export const DEFAULT_CEILING = 12;

const parkComment = (
	epicNumber: number,
	reason: StallReason,
	defects: ReadonlyArray<Defect>,
): string => {
	const why =
		reason === "repeated-signature"
			? "the same hard-defect set recurred after a re-plan (a cycle — re-planning is not changing the structural outcome)"
			: reason === "non-shrinking"
				? "the hard-defect set stopped shrinking across a re-plan (a stall — re-planning is no longer making progress)"
				: "the re-plan ceiling was reached without convergence (runaway backstop)";
	const rows = defects
		.map((d) => `- \`${d.type}\` (${d.refs.map((n) => `#${n}`).join(", ")}) — ${d.message}`)
		.join("\n");
	return [
		"**review-plan: PARKED — needs-info**",
		"",
		`The re-plan convergence loop parked epic #${epicNumber} because ${why}.`,
		"The unresolved hard defects below need a human or a different plan; the loop will not re-plan again:",
		"",
		rows,
	].join("\n");
};

/**
 * One step's decision, the value the body produces and the `Schedule.while`
 * predicate reads. `continue: true` means "the last pass was a still-shrinking
 * FAIL, keep going"; `false` means the loop reached a terminal state (converged,
 * or a stall the body already recorded into `terminal`).
 */
interface StepResult {
	readonly continue: boolean;
	readonly terminal: LoopOutcome | undefined;
}

/** The convergence state threaded across iterations via a `Ref`. */
interface LoopState {
	readonly iteration: number;
	readonly prevSignature: string | undefined;
	readonly prevCount: number | undefined;
}

const INITIAL: LoopState = {iteration: 0, prevSignature: undefined, prevCount: undefined};

/**
 * Drive an epic to a clean gate, re-planning on FAIL while the defect set
 * strictly shrinks, parking on a stall. The first pass gates the
 * already-`status:planned` ledger; each later pass re-plans first. The stop
 * condition is the cross-iteration shrink relation (held in a `Ref`), with
 * `Schedule.recurs(ceiling)` as the runaway backstop.
 */
export const runConvergenceLoop = Effect.fn("ReviewPlan.runConvergenceLoop")(function* (
	epicNumber: number,
	options?: {readonly ceiling?: number},
) {
	const github = yield* Github;
	const rePlanner = yield* RePlanner;
	const ceiling = options?.ceiling ?? DEFAULT_CEILING;

	const state = yield* Ref.make<LoopState>(INITIAL);
	const finalRef = yield* Ref.make<LoopOutcome | undefined>(undefined);

	const park = (
		reason: StallReason,
		defects: ReadonlyArray<Defect>,
		iteration: number,
	): Effect.Effect<LoopOutcome, GhCommandError> =>
		Effect.gen(function* () {
			yield* github.postComment(epicNumber, parkComment(epicNumber, reason, defects));
			yield* github.parkNeedsInfo(epicNumber);
			return {
				_tag: "parked",
				epicNumber,
				reason,
				defects,
				iterations: iteration,
			} satisfies LoopOutcome;
		});

	const decide = (
		verdict: GateVerdict,
		prev: LoopState,
		iteration: number,
	): Effect.Effect<StepResult, GhCommandError> =>
		Effect.gen(function* () {
			if (verdict._tag === "pass") {
				const terminal = {
					_tag: "converged",
					epicNumber,
					flipped: verdict.flipped,
					iterations: iteration,
				} satisfies LoopOutcome;
				return {continue: false, terminal};
			}

			const {defects, signature} = verdict;

			if (prev.prevSignature !== undefined && signature === prev.prevSignature) {
				return {continue: false, terminal: yield* park("repeated-signature", defects, iteration)};
			}
			if (prev.prevCount !== undefined && defects.length >= prev.prevCount) {
				return {continue: false, terminal: yield* park("non-shrinking", defects, iteration)};
			}

			// Still shrinking — record this pass's signature/count and keep going.
			yield* Ref.set(state, {iteration, prevSignature: signature, prevCount: defects.length});
			return {continue: true, terminal: undefined};
		});

	// One pass: re-plan (every pass after the first), gate, then decide. On a
	// terminal pass the body pins the outcome into `finalRef`; the `Schedule.while`
	// predicate stops the repeat by reading `StepResult.continue`.
	const body: Effect.Effect<StepResult, LoopError, Github | RePlanner> = Effect.gen(function* () {
		const prev = yield* Ref.get(state);
		const iteration = prev.iteration + 1;
		if (iteration > 1) {
			yield* rePlanner.rePlan(epicNumber);
		}
		const verdict = yield* runGate(epicNumber);
		const result = yield* decide(verdict, prev, iteration);
		if (result.terminal !== undefined) {
			yield* Ref.set(finalRef, result.terminal);
		}
		return result;
	});

	const schedule = Schedule.recurs(ceiling).pipe(
		Schedule.while((meta: Schedule.Metadata<number, StepResult>) => meta.input.continue),
	);

	yield* Effect.repeat(body, schedule);

	const final = yield* Ref.get(finalRef);
	if (final !== undefined) return final;

	// The ceiling was exhausted while the set was still shrinking (the backstop
	// fired before convergence/stall): park on the runaway reason.
	const last = yield* Ref.get(state);
	const verdict = yield* runGate(epicNumber);
	const defects = verdict._tag === "fail" ? verdict.defects : [];
	return yield* park("ceiling", defects, last.iteration);
});
