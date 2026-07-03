/**
 * `eval-harness` repair-churn cost core — net-token pricing of a stochastic model swap
 * (issue #1850, epic #1842).
 *
 * ADR 0112's token-economics gate is binary-per-run: it prices a stage's spend on a single
 * frozen input, which is enough for a deterministic lever flip but blind to the downstream
 * cost of a *stochastic* model swap. A cheaper model that fails the gate more often forces
 * extra write-code→review→repair cycles, and those cycles burn tokens the per-run saving
 * never accounted for — the epic's headline risk. This core prices that churn so a swap is
 * judged on NET tokens, not the per-run delta alone.
 *
 * The model, stated so the number is reproducible (full derivation in README.md):
 *   - Each attempt independently passes the gate with probability `passRate = p`.
 *   - Attempts repeat until one passes ⇒ a geometric distribution with success prob `p`.
 *   - Expected attempts = 1/p ⇒ expected EXTRA cycles beyond the first = (1 − p) / p.
 *   - Churn tokens = expected extra cycles × the token cost of one repair cycle.
 * At p = 1 the extra cycles are exactly 0; at p = 0 the model never passes and churn is
 * `+Infinity` (unbounded — never adopt), the honest limit of (1 − p)/p, not a hidden NaN.
 *
 * Only a *repair-forcing* failure (a gate FAIL) drives this churn — a crash / infra flake is
 * a `failure-classifier` TRANSIENT death (`failure-classifier.ts`), not a fail the model owns,
 * so it must NOT enter `passRate`. Conflating the two inflates churn with flakiness the swap
 * doesn't cause; `passRate` is the fraction of *graded* runs that PASS, crashes excluded.
 *
 * The token inputs are sourced from the existing `token-spend` reconstruction (ADR 0112 §2 —
 * the four-`usage`-component offline sum), reused read-only via `tokensFromTranscript` below;
 * this core never mints a second token meter.
 */
import {Data, Result} from "effect";
import * as Schema from "effect/Schema";
import {reconstructSpend} from "../token-spend/token-spend.ts";

/** A gate pass probability p ∈ [0, 1] for a (stage × model) — the fraction of graded runs that PASS. */
const PassRate = Schema.Finite.pipe(
	Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
);

/** A finite, non-negative billed-token count (a `token-spend` reconstruction total). */
const TokenCount = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * The validated inputs to a churn pricing — a domain type, not three bare numbers: an
 * out-of-range `passRate` or a negative token count is unrepresentable here, decoded through
 * this schema before any arithmetic runs.
 */
export const RepairChurnInput = Schema.Struct({
	passRate: PassRate,
	tokensPerRun: TokenCount,
	tokensPerRepairCycle: TokenCount,
});

export type RepairChurnInput = typeof RepairChurnInput.Type;

/** A typed input-validation failure — an out-of-range `passRate` or a negative token count. */
export class RepairChurnInputError extends Data.TaggedError("RepairChurnInputError")<{
	readonly message: string;
}> {}

/** The priced churn for one (stage × model), derived from a validated `RepairChurnInput`. */
export interface RepairChurnCost {
	/** The pass probability the pricing used (echoed for legibility). */
	readonly passRate: number;
	/** Expected repair cycles beyond the first attempt: `(1 − passRate) / passRate`. */
	readonly expectedExtraCycles: number;
	/** `expectedExtraCycles × tokensPerRepairCycle` — the extra tokens the churn burns per run. */
	readonly churnTokens: number;
	/**
	 * `tokensPerRun + churnTokens` — the true cost of one *accepted* run once the expected
	 * repair churn is amortized in. This is the figure a model swap is compared on, net.
	 */
	readonly amortizedTokensPerRun: number;
}

/** The pure geometric pricing over the already-validated domain type. */
const compute = (input: RepairChurnInput): RepairChurnCost => {
	const expectedExtraCycles = (1 - input.passRate) / input.passRate;
	// A never-passing model (passRate=0 → infinite expected cycles) is never-adopt regardless of
	// the per-repair token figure — so churn is +Infinity, NOT `Infinity * 0 = NaN` (which would
	// slip past the `netSaving < 0` never-adopt check, since `NaN < 0` is false).
	const churnTokens = Number.isFinite(expectedExtraCycles)
		? expectedExtraCycles * input.tokensPerRepairCycle
		: Number.POSITIVE_INFINITY;
	return {
		passRate: input.passRate,
		expectedExtraCycles,
		churnTokens,
		amortizedTokensPerRun: input.tokensPerRun + churnTokens,
	};
};

const decodeInput = Schema.decodeUnknownResult(RepairChurnInput);

const decode = (input: unknown): Result.Result<RepairChurnInput, RepairChurnInputError> =>
	decodeInput(input).pipe(
		Result.mapError((error) => new RepairChurnInputError({message: error.message})),
	);

/**
 * Price the repair churn a (stage × model)'s pass-rate forces, on net tokens. Total — an
 * invalid input (`passRate ∉ [0,1]`, a negative token count, a non-finite number) returns a
 * typed `Result` failure, never a throw or a NaN. `passRate = 0` yields `+Infinity` churn:
 * a model that never passes costs unbounded churn, the honest limit of the geometric model.
 */
export const repairChurnCost = (
	input: unknown,
): Result.Result<RepairChurnCost, RepairChurnInputError> => decode(input).pipe(Result.map(compute));

/** The net verdict on swapping a baseline model for a candidate, priced on churn-amortized tokens. */
export interface ModelSwapPricing {
	/** The naive per-run saving the cheaper candidate promises: `baseline − candidate` per-run. */
	readonly perRunSaving: number;
	/** The candidate's priced repair churn. */
	readonly churn: RepairChurnCost;
	/**
	 * `baselineTokensPerRun − candidate.amortizedTokensPerRun` — the saving that survives the
	 * extra churn. Negative ⇒ the churn ate the saving (the epic's crossover): do NOT adopt.
	 */
	readonly netSaving: number;
}

/**
 * Price swapping a `baselineTokensPerRun` incumbent for a cheaper `candidate` on NET tokens:
 * the per-run saving the candidate promises minus the extra repair churn its lower pass-rate
 * forces. A `netSaving < 0` is the crossover the binary-per-run gate cannot see — the
 * cheaper model is net-negative once its churn is priced in. Total — propagates the
 * candidate's input-validation failure.
 */
export const priceModelSwap = (args: {
	readonly baselineTokensPerRun: number;
	readonly candidate: unknown;
}): Result.Result<ModelSwapPricing, RepairChurnInputError> =>
	decode(args.candidate).pipe(
		Result.map((candidate) => {
			const churn = compute(candidate);
			return {
				perRunSaving: args.baselineTokensPerRun - candidate.tokensPerRun,
				churn,
				netSaving: args.baselineTokensPerRun - churn.amortizedTokensPerRun,
			};
		}),
	);

/**
 * The billed-token figure a churn pricing consumes, sourced from a `token-spend`
 * reconstruction of a stage transcript — the four-`usage`-component offline sum, reused
 * read-only. See ADR 0112 §2; this is the single meter, never a second one.
 */
export const tokensFromTranscript = (transcript: string): number =>
	reconstructSpend(transcript).billed;
