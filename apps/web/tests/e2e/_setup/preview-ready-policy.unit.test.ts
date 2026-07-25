import {describe, expect, it} from "vitest";
import {
	describeProbe,
	formatAttemptFailure,
	formatWarm,
	PROBE_KIND,
	PreviewNotWarmError,
	probeTimeoutMs,
	sleepAfterAttemptMs,
} from "./preview-ready-policy.cjs";

const route = {kind: PROBE_KIND.spaRoute, target: "/pano/yeni"};

describe("probeTimeoutMs — the hard cap is actually hard", () => {
	it("gives a probe its full timeout while the budget is wide open", () => {
		expect(probeTimeoutMs({remainingMs: 90_000, attemptTimeoutMs: 10_000})).toBe(10_000);
	});

	it("clamps the last probe to what is left, so an attempt cannot outlive the cap", () => {
		expect(probeTimeoutMs({remainingMs: 2_500, attemptTimeoutMs: 10_000})).toBe(2_500);
	});

	it("returns null once the budget is spent, so no probe starts on borrowed time", () => {
		expect(probeTimeoutMs({remainingMs: 0, attemptTimeoutMs: 10_000})).toBeNull();
		expect(probeTimeoutMs({remainingMs: -1, attemptTimeoutMs: 10_000})).toBeNull();
	});
});

describe("sleepAfterAttemptMs — the poll interval rate-limits attempts, it is not dead time", () => {
	it("does not sleep after a probe that already waited longer than the interval", () => {
		// The live #3176 shape: a 10s topbar timeout is 3x the interval of backoff
		// already; the old fixed 3s sleep spent budget buying nothing.
		expect(
			sleepAfterAttemptMs({attemptElapsedMs: 10_000, pollIntervalMs: 3_000, remainingMs: 60_000}),
		).toBe(0);
	});

	it("sleeps only the unspent remainder after a fast failure", () => {
		expect(
			sleepAfterAttemptMs({attemptElapsedMs: 500, pollIntervalMs: 3_000, remainingMs: 60_000}),
		).toBe(2_500);
	});

	it("never sleeps past the deadline", () => {
		expect(
			sleepAfterAttemptMs({attemptElapsedMs: 0, pollIntervalMs: 3_000, remainingMs: 800}),
		).toBe(800);
		expect(sleepAfterAttemptMs({attemptElapsedMs: 0, pollIntervalMs: 3_000, remainingMs: -5})).toBe(
			0,
		);
	});
});

describe("attribution — the next occurrence names itself", () => {
	it("names the probe kind and target", () => {
		expect(describeProbe(route)).toBe("spa-route /pano/yeni");
		expect(describeProbe({kind: PROBE_KIND.authWrite, target: "/api/auth/sign-up/email"})).toBe(
			"auth-write /api/auth/sign-up/email",
		);
	});

	it("the retry line says WHICH probe stalled, not just that something did", () => {
		const line = formatAttemptFailure({
			attempt: 3,
			probe: route,
			probeElapsedMs: 10_014,
			remainingMs: 51_000,
			sleepMs: 0,
			lastError: "locator.waitFor: Timeout 10000ms exceeded.",
		});
		expect(line).toContain("attempt 3");
		expect(line).toContain("spa-route /pano/yeni");
		expect(line).toContain("51000ms of budget left");
	});

	it("the success line states the gate PASSED, closing the #3179 misreading", () => {
		const line = formatWarm({
			baseURL: "https://preview.example/",
			attempts: 5,
			elapsedMs: 57_000,
			probeCount: 7,
		});
		expect(line).toContain("THE READINESS GATE PASSED");
		expect(line).toContain("not preview warmth");
	});

	it("the failure is a named error carrying the probe, attempts and elapsed time", () => {
		const err = new PreviewNotWarmError({
			baseURL: "https://preview.example/",
			budgetMs: 90_000,
			elapsedMs: 90_120,
			attempts: 8,
			probe: route,
			lastError: "locator.waitFor: Timeout 10000ms exceeded.",
		});
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("PreviewNotWarmError");
		expect(err.probe).toEqual(route);
		expect(err.attempts).toBe(8);
		expect(err.message).toContain("spa-route /pano/yeni");
		expect(err.message).toContain("8 attempt(s)");
	});

	it("the failure disowns the spec name Playwright will print beside it", () => {
		// The whole cost of #3179: a globalSetup throw is reported against an
		// arbitrary spec, and a reader chased a sözlük product bug that wasn't there.
		const err = new PreviewNotWarmError({
			baseURL: "https://preview.example/",
			budgetMs: 90_000,
			elapsedMs: 90_120,
			attempts: 8,
			probe: route,
			lastError: "boom",
		});
		expect(err.message).toContain("NOT a spec failure");
		expect(err.message).toContain("arbitrary");
	});

	it("stays legible when the preview was dead from the first probe", () => {
		const err = new PreviewNotWarmError({
			baseURL: "https://preview.example/",
			budgetMs: 90_000,
			elapsedMs: 90_000,
			attempts: 1,
			probe: null,
			lastError: "net::ERR_CONNECTION_REFUSED",
		});
		expect(err.message).toContain("(no attempt completed)");
		expect(err.message).toContain("net::ERR_CONNECTION_REFUSED");
	});
});
