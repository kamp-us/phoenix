/**
 * The token-bucket rate-limit algorithm as a pure domain object (ADR 0177). No clock,
 * no store, no Effect: `nowMs` is passed in, so the algorithm behaves identically
 * whether its state lives in an isolate `Map` today or a per-actor Durable Object
 * later.
 */

export interface TokenBucketState {
	readonly tokens: number;
	readonly lastRefillMs: number;
}

// Both fields are positive by construction: {@link tokenBucketPolicy} is the only
// constructor and rejects a non-positive value, so an unfillable bucket cannot exist.
export interface TokenBucketPolicy {
	readonly capacity: number;
	readonly refillPerSecond: number;
}

// Throws rather than fails: a bad policy is a misconfiguration, never a runtime input.
export const tokenBucketPolicy = (capacity: number, refillPerSecond: number): TokenBucketPolicy => {
	if (!(capacity > 0) || !(refillPerSecond > 0)) {
		throw new Error(
			`invalid token-bucket policy: capacity=${capacity} refillPerSecond=${refillPerSecond} (both must be > 0)`,
		);
	}
	return {capacity, refillPerSecond};
};

export const initialState = (policy: TokenBucketPolicy, nowMs: number): TokenBucketState => ({
	tokens: policy.capacity,
	lastRefillMs: nowMs,
});

// Clock-skew-safe: a backwards `nowMs` clamps elapsed to 0, so a bucket never loses
// tokens and `lastRefillMs` only advances.
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

export interface ConsumeResult {
	readonly allowed: boolean;
	readonly state: TokenBucketState;
	readonly retryAfterMs: number;
}

// On denial the returned state is still the REFILLED bucket, so the next call sees the
// elapsed time.
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
