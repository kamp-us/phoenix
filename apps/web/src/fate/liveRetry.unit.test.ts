/**
 * The pure decision core of the ADR-0095 client cold-start handling: which
 * live-errors are the transient `LIVE_UNAVAILABLE`/503 back-off signal (retry) vs a
 * genuine app error (drop to console), and the bounded back-off schedule. The React
 * wiring in `useGlobalLivePin` / `FateProvider` is exercised separately once the SPA
 * has a component-test seam (#1419) — this tier covers the falsifiable logic.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	createLiveRetryController,
	isTransientLiveError,
	LIVE_RETRY_MAX_ATTEMPTS,
	nextLiveRetryDelayMs,
} from "./liveRetry.ts";

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

describe("createLiveRetryController", () => {
	// Fake timers model the back-off elapsing without wall-clock waits; the controller
	// uses the global `setTimeout`/`clearTimeout` these replace.
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("coalesces a burst of errors from one failed connect into ONE scheduled retry", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		// One cold connect fans its error out to 3 mounted subscriptions → 3 schedule()
		// calls. Only the first arms a timer; the rest are absorbed.
		controller.schedule(fire);
		controller.schedule(fire);
		controller.schedule(fire);

		expect(vi.getTimerCount()).toBe(1);
	});

	it("uses the exact scheduled back-off delay for a connect (attempt 0 = 250ms)", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		controller.schedule(fire);
		vi.advanceTimersByTime(nextLiveRetryDelayMs(0) - 1);
		expect(fire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("charges the budget per connect, not per error — N views do not drain it faster", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		// Each round = one failed cold connect that reports an error to 3 subscriptions,
		// then the back-off elapses and the reconnect fires. The budget must last exactly
		// LIVE_RETRY_MAX_ATTEMPTS rounds regardless of the 3× error fan-out.
		for (let round = 0; round < LIVE_RETRY_MAX_ATTEMPTS; round++) {
			controller.schedule(fire);
			controller.schedule(fire);
			controller.schedule(fire);
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(nextLiveRetryDelayMs(round));
		}

		expect(fire).toHaveBeenCalledTimes(LIVE_RETRY_MAX_ATTEMPTS);

		// Budget spent: a further failed connect schedules nothing.
		controller.schedule(fire);
		expect(vi.getTimerCount()).toBe(0);
		expect(fire).toHaveBeenCalledTimes(LIVE_RETRY_MAX_ATTEMPTS);
	});

	it("reset() restores the full budget and drops any pending retry (new identity)", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		for (let round = 0; round < LIVE_RETRY_MAX_ATTEMPTS; round++) {
			controller.schedule(fire);
			vi.advanceTimersByTime(nextLiveRetryDelayMs(round));
		}
		controller.schedule(fire); // budget spent → no-op
		expect(vi.getTimerCount()).toBe(0);

		controller.reset();
		controller.schedule(fire);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(nextLiveRetryDelayMs(0)); // back-off restarts from attempt 0
		expect(fire).toHaveBeenCalledTimes(LIVE_RETRY_MAX_ATTEMPTS + 1);
	});

	it("reset() cancels a pending retry so it never fires onto a re-keyed client", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		controller.schedule(fire);
		expect(vi.getTimerCount()).toBe(1);
		controller.reset();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(fire).not.toHaveBeenCalled();
	});

	it("cancel() drops a pending retry without firing it (unmount)", () => {
		const controller = createLiveRetryController();
		const fire = vi.fn();

		controller.schedule(fire);
		controller.cancel();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(fire).not.toHaveBeenCalled();
	});
});
