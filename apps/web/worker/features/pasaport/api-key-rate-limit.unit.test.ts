/**
 * The apiKey plugin's per-key `rateLimit` (ADR 0044 Decision 3, #108) — the agent
 * half of the rate mechanism. Asserting the declared config directly is how the
 * "bounded independently" invariant is verified without firing thousands of requests:
 * the shape is the proof. It must be ENABLED with a finite window + max, so a single
 * key's velocity is capped rather than unbounded (a disabled or absent bound would let
 * one runaway key issue without limit). Kept in step with #110's per-user backstop.
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
