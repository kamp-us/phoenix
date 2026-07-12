/**
 * The token-bucket domain object (ADR 0177) — the rate-limit algorithm proven
 * store-free: refill-by-elapsed-time, consume, deny-at-empty, clock-skew safety.
 * The `RateLimiter` service and the DO/in-isolate backing reuse this same math,
 * so pinning it here is what lets those higher layers stay thin.
 */
import {describe, expect, it} from "vitest";
import {initialState, refill, tokenBucketPolicy, tryConsume} from "./TokenBucket.ts";

const policy = tokenBucketPolicy(3, 1); // 3-token burst, refilling 1/s

describe("TokenBucket (ADR 0177)", () => {
	it("rejects a non-positive policy at construction", () => {
		expect(() => tokenBucketPolicy(0, 1)).toThrow();
		expect(() => tokenBucketPolicy(3, 0)).toThrow();
		expect(() => tokenBucketPolicy(-1, 1)).toThrow();
	});

	it("starts full, consumes down to empty, then denies with a retry hint", () => {
		let state = initialState(policy, 0);
		for (let i = 0; i < 3; i++) {
			const r = tryConsume(state, policy, 0);
			expect(r.allowed).toBe(true);
			state = r.state;
		}
		const denied = tryConsume(state, policy, 0);
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfterMs).toBe(1000); // one token at 1/s
	});

	it("refills by elapsed wall time, capped at capacity", () => {
		const empty = {tokens: 0, lastRefillMs: 0};
		expect(refill(empty, policy, 2000).tokens).toBe(2); // 2s × 1/s
		expect(refill(empty, policy, 10_000).tokens).toBe(3); // capped at capacity
	});

	it("a denied bucket is allowed again once a token refills", () => {
		const empty = {tokens: 0, lastRefillMs: 0};
		expect(tryConsume(empty, policy, 0).allowed).toBe(false);
		expect(tryConsume(empty, policy, 1000).allowed).toBe(true);
	});

	it("is clock-skew safe — a backwards clock never adds or removes tokens", () => {
		const state = {tokens: 1, lastRefillMs: 5000};
		expect(refill(state, policy, 1000).tokens).toBe(1); // now < lastRefill
	});

	it("treats an absent bucket as a fresh full one", () => {
		const r = tryConsume(undefined, policy, 0);
		expect(r.allowed).toBe(true);
		expect(r.state.tokens).toBe(2); // capacity 3, minus the token just spent
	});
});
