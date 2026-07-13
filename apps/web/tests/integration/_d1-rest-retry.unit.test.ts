/**
 * Pins that `cfFetchWithRateLimitRetry` retries ONLY the transient CF 429 (the #2915
 * D1-429 batch flake) and never masks a real failure: a non-429 answer (success or a real
 * error) is returned at once, a persistent 429 exhausts the bounded budget and surfaces the
 * final 429, and the backoff stays within its full-jitter window. `sleep`/`random` are
 * injected so the whole suite runs offline and instantly.
 */

import {describe, expect, it, vi} from "vitest";
import {
	CF_RATE_LIMIT_STATUS,
	cfFetchWithRateLimitRetry,
	D1_REST_BASE_DELAY_MS,
} from "./_d1-rest-retry.ts";

// A minimal `Response` stand-in — the retry only reads `.status` and cancels `.body`.
const resp = (status: number): Response =>
	new Response(status === CF_RATE_LIMIT_STATUS ? "429" : "ok", {status});

// A `send` that yields the given statuses in order (last one repeats once exhausted).
const sequence = (statuses: number[]) => {
	let i = 0;
	const send = vi.fn(async () => resp(statuses[Math.min(i++, statuses.length - 1)]!));
	return send;
};

const noSleep = () => Promise.resolve();

describe("cfFetchWithRateLimitRetry", () => {
	it("returns the first non-429 response without retrying (no 429 → no sleep)", async () => {
		const send = sequence([200]);
		const sleep = vi.fn(noSleep);
		const res = await cfFetchWithRateLimitRetry(send, {sleep});
		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("retries a 429 then returns the settled 200 (the #2915 recovery path)", async () => {
		const send = sequence([429, 429, 200]);
		const sleep = vi.fn(noSleep);
		const res = await cfFetchWithRateLimitRetry(send, {sleep, random: () => 0.5});
		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(3); // initial + 2 retries
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry a non-429 error — a real failure surfaces at once", async () => {
		const send = sequence([500]);
		const sleep = vi.fn(noSleep);
		const res = await cfFetchWithRateLimitRetry(send, {sleep});
		expect(res.status).toBe(500);
		expect(send).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("exhausts the bounded budget on a persistent 429 and returns the final 429", async () => {
		const send = sequence([429]);
		const sleep = vi.fn(noSleep);
		const res = await cfFetchWithRateLimitRetry(send, {maxRetries: 5, sleep});
		expect(res.status).toBe(429);
		expect(send).toHaveBeenCalledTimes(6); // initial + 5 retries, then it stops
		expect(sleep).toHaveBeenCalledTimes(5);
	});

	it("backs off with full jitter within [0, base·2^attempt) per retry", async () => {
		const delays: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			delays.push(ms);
		});
		// random() = 1 - ε maximizes the delay; floor keeps it strictly below the ceiling.
		await cfFetchWithRateLimitRetry(sequence([429]), {
			maxRetries: 3,
			baseDelayMs: D1_REST_BASE_DELAY_MS,
			sleep,
			random: () => 0.999999,
		});
		expect(delays).toHaveLength(3);
		delays.forEach((ms, attempt) => {
			const ceil = D1_REST_BASE_DELAY_MS * 2 ** attempt;
			expect(ms).toBeGreaterThanOrEqual(0);
			expect(ms).toBeLessThan(ceil);
		});
	});
});
