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
 * flat ceiling is the runaway backstop.
 *
 * ## Recursion, not a Schedule
 *
 * `step` is a tail-recursive Effect: it gates the epic, and on a still-shrinking
 * FAIL re-plans and calls itself with the carried `LoopState` (the iteration plus
 * the previous pass's signature/count/defects, the cross-iteration facts the stall
 * tests compare); the converged/parked/ceiling cases return the `LoopOutcome`
 * directly, so the outcome is the recursion's return value. One piece of
 * recursion-carried state, control flow linear top-to-bottom.
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
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import type {Defect} from "./Defect.ts";
import {type GateVerdict, runGate} from "./gate.ts";
import type {GhCommandError, GhParseError, RepoResolutionError} from "./github.ts";
import {Github} from "./github.ts";

/** Everything the loop's effects can fail with: gate IO faults + a re-plan fault. */
type LoopError =
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError
	| RePlanError;

/**
 * A re-plan failed. `rePlan(epicNumber)` re-invokes `plan-epic` on the epic and
 * resolves once the epic body + children have been re-written; if its real
 * mechanism (a subagent spawn, a queued job, a shell-out) fails, the caller
 * surfaces it as this tag — distinct from the gh-infra `GhCommandError` so a
 * consumer's `catchTag` can tell a re-plan fault from a `gh` exit. Standalone
 * tagged error per `.patterns/effect-errors.md`.
 */
export class RePlanError extends Schema.TaggedErrorClass<RePlanError>()(
	"@kampus/epic-ledger/RePlanError",
	{
		epicNumber: Schema.Number,
		message: Schema.String,
	},
) {}

export class RePlanner extends Context.Service<
	RePlanner,
	{
		readonly rePlan: (epicNumber: number) => Effect.Effect<void, RePlanError>;
	}
>()("@kampus/epic-ledger/RePlanner") {}

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
 * The runaway backstop ceiling. High by design: convergence or a stall should
 * always fire first. This is the only fixed-count element and it is *not* the
 * stop condition (the stall tests are).
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
 * The convergence state carried into each recursive `step`. After the first pass
 * the previous FAIL's signature/count/defects are present; the stall tests
 * compare this pass against them, and the ceiling park reuses `prevDefects`
 * without re-gating.
 */
interface LoopState {
	readonly iteration: number;
	readonly prevSignature: string | undefined;
	readonly prevCount: number | undefined;
	readonly prevDefects: ReadonlyArray<Defect>;
}

const INITIAL: LoopState = {
	iteration: 1,
	prevSignature: undefined,
	prevCount: undefined,
	prevDefects: [],
};

/**
 * Drive an epic to a clean gate, re-planning on FAIL while the defect set
 * strictly shrinks, parking on a stall. The first pass gates the
 * already-`status:planned` ledger; each later pass re-plans first. `step` carries
 * the cross-iteration shrink relation as its argument and returns the terminal
 * `LoopOutcome`; `DEFAULT_CEILING` guards against a runaway.
 */
export const runConvergenceLoop = Effect.fn("ReviewPlan.runConvergenceLoop")(function* (
	epicNumber: number,
	options?: {readonly ceiling?: number},
) {
	const github = yield* Github;
	const rePlanner = yield* RePlanner;
	const ceiling = options?.ceiling ?? DEFAULT_CEILING;

	const park = (
		reason: StallReason,
		defects: ReadonlyArray<Defect>,
		iteration: number,
	): Effect.Effect<LoopOutcome, RepoResolutionError | GhCommandError> =>
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

	const step = (prev: LoopState): Effect.Effect<LoopOutcome, LoopError, Github | RePlanner> =>
		Effect.gen(function* () {
			if (prev.iteration > ceiling) {
				return yield* park("ceiling", prev.prevDefects, prev.iteration - 1);
			}

			if (prev.iteration > 1) {
				yield* rePlanner.rePlan(epicNumber);
			}

			const verdict: GateVerdict = yield* runGate(epicNumber);
			if (verdict._tag === "pass") {
				return {
					_tag: "converged",
					epicNumber,
					flipped: verdict.flipped,
					iterations: prev.iteration,
				} satisfies LoopOutcome;
			}

			const {defects, signature} = verdict;
			if (prev.prevSignature !== undefined && signature === prev.prevSignature) {
				return yield* park("repeated-signature", defects, prev.iteration);
			}
			if (prev.prevCount !== undefined && defects.length >= prev.prevCount) {
				return yield* park("non-shrinking", defects, prev.iteration);
			}

			return yield* step({
				iteration: prev.iteration + 1,
				prevSignature: signature,
				prevCount: defects.length,
				prevDefects: defects,
			});
		});

	return yield* step(INITIAL);
});
