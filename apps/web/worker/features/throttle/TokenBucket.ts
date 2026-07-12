/**
 * The token-bucket rate-limit algorithm as a pure domain object (ADR 0177):
 * state + policy + the two transitions (refill-by-elapsed-time, try-consume).
 * No clock, no store, no Effect — `nowMs` is passed in, so the algorithm is
 * exhaustively unit-testable and byte-identical whether its state lives in an
 * isolate `Map` today or a per-actor Durable Object when registration opens.
 */

/** A bucket's state: tokens remaining and the wall time they were last refilled. */
export interface TokenBucketState {
	readonly tokens: number;
	readonly lastRefillMs: number;
}

/**
 * A bucket's fixed shape: `capacity` is the burst ceiling (and the full-bucket
 * start), `refillPerSecond` the sustained rate. Both are positive by
 * construction — {@link tokenBucketPolicy} is the only constructor and rejects a
 * non-positive value, so an unfillable bucket is unrepresentable.
 */
export interface TokenBucketPolicy {
	readonly capacity: number;
	readonly refillPerSecond: number;
}

/** The only `TokenBucketPolicy` constructor — throws on a non-positive value (a
 * misconfiguration, i.e. a programmer error, never a runtime input). */
export const tokenBucketPolicy = (capacity: number, refillPerSecond: number): TokenBucketPolicy => {
	if (!(capacity > 0) || !(refillPerSecond > 0)) {
		throw new Error(
			`invalid token-bucket policy: capacity=${capacity} refillPerSecond=${refillPerSecond} (both must be > 0)`,
		);
	}
	return {capacity, refillPerSecond};
};

/** A brand-new, full bucket at `nowMs`. */
export const initialState = (policy: TokenBucketPolicy, nowMs: number): TokenBucketState => ({
	tokens: policy.capacity,
	lastRefillMs: nowMs,
});

/**
 * Refill by elapsed wall time, capped at `capacity`. Clock-skew-safe: a
 * backwards `nowMs` clamps elapsed to 0, so a bucket never loses tokens and
 * `lastRefillMs` only advances.
 */
export const refill = (
	state: TokenBucketState,
	policy: TokenBucketPolicy,
	nowMs: number,
): TokenBucketState => {
	const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
	if (elapsedMs === 0) return state;
	const refilled = Math.min(
		policy.capacity,
		state.tokens + (elapsedMs / 1000) * policy.refillPerSecond,
	);
	return {tokens: refilled, lastRefillMs: nowMs};
};

/** The outcome of a {@link tryConsume}: whether it was allowed, the resulting
 * state to persist, and the wait until the next token when denied (0 if allowed). */
export interface ConsumeResult {
	readonly allowed: boolean;
	readonly state: TokenBucketState;
	readonly retryAfterMs: number;
}

/**
 * Spend one token: refill first, then consume iff at least one token remains. On
 * denial the state is still the refilled bucket (so the next call sees the
 * elapsed time) and `retryAfterMs` is the wait until one token accrues.
 */
export const tryConsume = (
	prev: TokenBucketState | undefined,
	policy: TokenBucketPolicy,
	nowMs: number,
): ConsumeResult => {
	const state = prev === undefined ? initialState(policy, nowMs) : refill(prev, policy, nowMs);
	if (state.tokens >= 1) {
		return {
			allowed: true,
			state: {tokens: state.tokens - 1, lastRefillMs: state.lastRefillMs},
			retryAfterMs: 0,
		};
	}
	const deficit = 1 - state.tokens;
	return {
		allowed: false,
		state,
		retryAfterMs: Math.ceil((deficit / policy.refillPerSecond) * 1000),
	};
};
