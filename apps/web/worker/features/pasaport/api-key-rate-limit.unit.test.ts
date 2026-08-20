/**
 * The apiKey plugin's per-key `rateLimit` (ADR 0044 Decision 3). Asserting the
 * declared config IS the proof of the "bounded independently" invariant, without
 * firing thousands of requests: a disabled or absent bound would let one runaway key
 * issue without limit.
 */
import {describe, expect, it} from "vitest";
import {apiKeyRateLimit} from "./better-auth-live.ts";

describe("apiKeyRateLimit — a per-key velocity bound is enabled and finite", () => {
	it("is enabled (a key is rate-limited, never unbounded)", () => {
		expect(apiKeyRateLimit.enabled).toBe(true);
	});

	it("caps requests to a finite positive maximum per window", () => {
		expect(apiKeyRateLimit.maxRequests).toBeGreaterThan(0);
		expect(Number.isFinite(apiKeyRateLimit.maxRequests)).toBe(true);
	});

	it("bounds the window to a finite positive duration", () => {
		expect(apiKeyRateLimit.timeWindow).toBeGreaterThan(0);
		expect(Number.isFinite(apiKeyRateLimit.timeWindow)).toBe(true);
	});
});
