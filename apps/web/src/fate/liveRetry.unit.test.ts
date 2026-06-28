/**
 * The pure decision core of the ADR-0095 client cold-start handling: which
 * live-errors are the transient `LIVE_UNAVAILABLE`/503 back-off signal (retry) vs a
 * genuine app error (drop to console), and the bounded back-off schedule. The React
 * wiring in `useGlobalLivePin` / `FateProvider` is exercised separately once the SPA
 * has a component-test seam (#1419) — this tier covers the falsifiable logic.
 */
import {describe, expect, it} from "vitest";
import {isTransientLiveError, LIVE_RETRY_MAX_ATTEMPTS, nextLiveRetryDelayMs} from "./liveRetry.ts";

describe("isTransientLiveError", () => {
	it("treats a 503 (the server's graceful cold-start envelope) as transient", () => {
		// fate's `responseError` rebuilds the LIVE_UNAVAILABLE/503 as a FateRequestError
		// whose `.code` is derived from status (503 → "INTERNAL_ERROR"); `.status` survives.
		expect(isTransientLiveError({status: 503, code: "INTERNAL_ERROR"})).toBe(true);
	});

	it("treats an explicit LIVE_UNAVAILABLE code (in-band protocol frame) as transient", () => {
		expect(isTransientLiveError({code: "LIVE_UNAVAILABLE", message: "warming"})).toBe(true);
	});

	it("does NOT retry a genuine 4xx app error", () => {
		expect(isTransientLiveError({status: 400, code: "BAD_REQUEST"})).toBe(false);
		expect(isTransientLiveError({status: 401, code: "UNAUTHORIZED"})).toBe(false);
		expect(isTransientLiveError({status: 403, code: "FORBIDDEN"})).toBe(false);
		expect(isTransientLiveError({status: 404, code: "NOT_FOUND"})).toBe(false);
	});

	it("does NOT retry a defect-500 (status 500, INTERNAL_ERROR)", () => {
		expect(isTransientLiveError({status: 500, code: "INTERNAL_ERROR"})).toBe(false);
	});

	it("does NOT retry a non-object error (opaque EventSource error, null, string)", () => {
		expect(isTransientLiveError(new Event("error"))).toBe(false);
		expect(isTransientLiveError(null)).toBe(false);
		expect(isTransientLiveError(undefined)).toBe(false);
		expect(isTransientLiveError("boom")).toBe(false);
	});
});

describe("nextLiveRetryDelayMs", () => {
	it("is capped exponential from attempt 0", () => {
		expect(nextLiveRetryDelayMs(0)).toBe(250);
		expect(nextLiveRetryDelayMs(1)).toBe(500);
		expect(nextLiveRetryDelayMs(2)).toBe(1000);
		expect(nextLiveRetryDelayMs(3)).toBe(2000);
		expect(nextLiveRetryDelayMs(4)).toBe(4000);
	});

	it("caps the back-off at 5000ms for any further attempt", () => {
		expect(nextLiveRetryDelayMs(5)).toBe(5000);
		expect(nextLiveRetryDelayMs(20)).toBe(5000);
	});

	it("clamps a negative attempt to the base delay (never below the floor)", () => {
		expect(nextLiveRetryDelayMs(-1)).toBe(250);
	});

	it("exposes a bounded retry budget", () => {
		expect(LIVE_RETRY_MAX_ATTEMPTS).toBeGreaterThan(0);
	});
});
