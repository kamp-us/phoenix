/**
 * Pins that `cfFetchWithRateLimitRetry` retries ONLY the transient CF 429 (the #2915
 * D1-429 batch flake) and never masks a real failure: a non-429 answer (success or a real
 * error) is returned at once, a persistent 429 exhausts the bounded budget and surfaces the
 * final 429, and the backoff stays within its full-jitter window. `sleep`/`random`/`now` are
 * injected so the whole suite runs offline and instantly.
 *
 * The #3548 additions are pinned at the bottom: the budget is a DEADLINE (an attempt-count budget
 * with full jitter could burn out in milliseconds against a minutes-long 429 plateau) measured
 * over time CF spent rate-limiting the call rather than wall clock, a CF-supplied `Retry-After`
 * floors the backoff, and giving up is self-identifying down to where the budget went.
 */

import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {makeD1Rest} from "@kampus/d1-rest";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {describe, expect, it, vi} from "vitest";
import {
	budgetSpentMs,
	CF_RATE_LIMIT_STATUS,
	CfRateLimitError,
	cfFetchWithRateLimitRetry,
	D1_REST_BASE_DELAY_MS,
	isCfRateLimit,
	type RateLimitAttrition,
	rateLimitRetryingFetch,
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
const noop = () => {};

/** A clock that advances by `stepMs` on every read — makes the wall-clock budget assertable. */
const tickingClock = (stepMs: number) => {
	let t = 0;
	return () => {
		const at = t;
		t += stepMs;
		return at;
	};
};

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
		const res = await cfFetchWithRateLimitRetry(send, {maxRetries: 5, sleep, onGiveUp: noop});
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
			onGiveUp: noop,
		});
		expect(delays).toHaveLength(3);
		delays.forEach((ms, attempt) => {
			const ceil = D1_REST_BASE_DELAY_MS * 2 ** attempt;
			expect(ms).toBeGreaterThanOrEqual(0);
			expect(ms).toBeLessThan(ceil);
		});
	});
});

// #3548: the budget that actually decides when to give up.
describe("the retry budget is a deadline, not an attempt count", () => {
	// A clock the injected sleep advances — the honest model of "waiting spends the budget".
	const clockedSleep = () => {
		let clock = 0;
		return {
			now: () => clock,
			sleep: vi.fn(async (ms: number) => {
				clock += ms;
			}),
			elapsed: () => clock,
		};
	};

	it("keeps retrying past the old 5-retry cap while budget remains, and stops exactly at it", async () => {
		const {now, sleep, elapsed} = clockedSleep();
		const send = sequence([429]);
		const res = await cfFetchWithRateLimitRetry(send, {
			budgetMs: 10_000,
			baseDelayMs: 1000,
			maxDelayMs: 2000,
			random: () => 0.999999,
			now,
			sleep,
			onGiveUp: noop,
		});
		expect(res.status).toBe(429);
		// The old attempt-count budget stopped at 6 sends however little time it had spent; the
		// deadline instead spends the whole 10s — the point of the #3548 change.
		expect(send.mock.calls.length).toBeGreaterThan(6);
		expect(elapsed()).toBe(10_000);
	});

	it("never waits past the deadline — the last wait is clamped to what remains", async () => {
		const {now, sleep, elapsed} = clockedSleep();
		await cfFetchWithRateLimitRetry(sequence([429]), {
			budgetMs: 1500,
			baseDelayMs: 1000,
			maxDelayMs: 8000,
			random: () => 0.999999,
			now,
			sleep,
			onGiveUp: noop,
		});
		expect(elapsed()).toBeLessThanOrEqual(1500);
	});

	it("budgetMs: 0 disables retrying entirely (the first answer stands)", async () => {
		const send = sequence([429]);
		const sleep = vi.fn(noSleep);
		const res = await cfFetchWithRateLimitRetry(send, {budgetMs: 0, sleep, onGiveUp: noop});
		expect(res.status).toBe(429);
		expect(send).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe("a CF-supplied Retry-After floors the backoff", () => {
	const with429 = (headers: Record<string, string>) =>
		vi.fn(async () => new Response("429", {status: 429, headers}));

	it("waits at least the delta-seconds CF asked for, not the (smaller) jittered backoff", async () => {
		const delays: number[] = [];
		await cfFetchWithRateLimitRetry(with429({"retry-after": "3"}), {
			maxRetries: 1,
			baseDelayMs: 100,
			random: () => 0, // jitter alone would wait 0ms
			sleep: async (ms) => {
				delays.push(ms);
			},
			now: tickingClock(0),
			onGiveUp: noop,
		});
		expect(delays).toEqual([3000]);
	});

	// A `Retry-After` past the deadline used to be clamped to `remaining`, so the loop slept out the
	// entire budget to buy one attempt at the exact moment it expired — CI time spent for near-zero
	// odds, and a slow red where a fast, correctly-named one was available.
	it("gives up at once when CF asks for longer than the budget left, instead of sleeping it out", async () => {
		const seen: RateLimitAttrition[] = [];
		const sleep = vi.fn(noSleep);
		const send = vi.fn(
			async () => new Response("429", {status: 429, headers: {"retry-after": "60"}}),
		);
		const res = await cfFetchWithRateLimitRetry(send, {
			budgetMs: 45_000,
			sleep,
			now: () => 0,
			onGiveUp: (a) => seen.push(a),
		});
		expect(res.status).toBe(429);
		expect(send).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(seen[0]?.reason).toBe("retry-after-exceeds-budget");
		expect(seen[0]?.retryAfterMs).toBe(60_000);
	});

	it("ignores an unparseable Retry-After and falls back to the jittered backoff", async () => {
		const delays: number[] = [];
		await cfFetchWithRateLimitRetry(with429({"retry-after": "soon"}), {
			maxRetries: 1,
			baseDelayMs: 100,
			random: () => 0.999999,
			sleep: async (ms) => {
				delays.push(ms);
			},
			now: tickingClock(0),
			onGiveUp: noop,
		});
		expect(delays).toEqual([99]);
	});
});

describe("giving up is self-identifying, and never a silent pass", () => {
	it("reports the label, attempt count and elapsed budget exactly once, only on exhaustion", async () => {
		const seen: RateLimitAttrition[] = [];
		await cfFetchWithRateLimitRetry(sequence([429]), {
			label: "POST /accounts/a/d1/database/b/query",
			maxRetries: 2,
			sleep: noSleep,
			now: tickingClock(10),
			onGiveUp: (a) => seen.push(a),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.label).toBe("POST /accounts/a/d1/database/b/query");
		expect(seen[0]?.attempts).toBe(3);
		expect(seen[0]?.elapsedMs).toBeGreaterThan(0);
		expect(seen[0]?.reason).toBe("max-retries");
	});

	// Round 1 said "2 attempts over 45136ms of retry budget" and left WHERE those 45s went to
	// be re-derived by hand from the job log. With the breakdown, 2 attempts against an
	// untouched budget reads as a queueing problem rather than a Cloudflare one.
	it("breaks the elapsed time down into queued / backoff / CF-facing budget spent", async () => {
		const seen: RateLimitAttrition[] = [];
		let clock = 0;
		await cfFetchWithRateLimitRetry(
			// Every attempt reports 1000ms of harness queueing and takes 1100ms of wall clock.
			async (queued) => {
				queued(1000);
				clock += 1100;
				return resp(429);
			},
			{
				budgetMs: 500,
				baseDelayMs: 100,
				random: () => 0.999999,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				onGiveUp: (a) => seen.push(a),
			},
		);
		const a = seen[0] as RateLimitAttrition;
		expect(a.reason).toBe("budget-exhausted");
		expect(a.attempts).toBe(3);
		expect(a.queuedMs).toBe(3000); // every attempt's throttle wait, deducted from the budget
		expect(a.backoffMs).toBe(298);
		expect(a.budgetMs).toBe(500);
		// Wall clock far outruns the 500ms budget because most of it was ours, not CF's.
		expect(a.elapsedMs).toBe(3598);
		expect(budgetSpentMs(a)).toBe(598);
	});

	// The other half of deducting `queuedMs`: with queueing uncharged, the CF-facing budget
	// alone stops bounding wall clock, and 24 attempts of deep queueing outlive vitest's 120s
	// testTimeout — trading the named 429 back for "Hook timed out". So deep queueing ends the
	// loop on the ceiling, saying so, rather than on the untouched budget.
	it("ends on the wall-clock ceiling when queueing (not CF) is what burnt the time", async () => {
		const seen: RateLimitAttrition[] = [];
		let clock = 0;
		await cfFetchWithRateLimitRetry(
			// Every attempt queues 20s in the harness's own throttle and answers 429 immediately.
			async (queued) => {
				queued(20_000);
				clock += 20_000;
				return resp(429);
			},
			{
				budgetMs: 45_000,
				wallClockCeilingMs: 90_000,
				maxRetries: 24,
				baseDelayMs: 1,
				random: () => 0,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				onGiveUp: (a) => seen.push(a),
			},
		);
		const a = seen[0] as RateLimitAttrition;
		expect(a.reason).toBe("wall-clock-ceiling");
		expect(a.elapsedMs).toBeGreaterThanOrEqual(90_000);
		// The runaway guard never got near 24, and CF never got its budget — which is exactly the
		// state the ceiling exists to end: we were queueing, not being rate-limited.
		expect(a.attempts).toBeLessThan(24);
		expect(budgetSpentMs(a)).toBeLessThan(45_000);
	});

	it("does NOT fire when the 429 clears — a recovered call is not reported as rate-limited", async () => {
		const onGiveUp = vi.fn();
		const res = await cfFetchWithRateLimitRetry(sequence([429, 200]), {sleep: noSleep, onGiveUp});
		expect(res.status).toBe(200);
		expect(onGiveUp).not.toHaveBeenCalled();
	});

	it("CfRateLimitError names the call and its attrition (the #3548 diagnosability bar)", () => {
		const err = new CfRateLimitError(
			"POST",
			"/accounts/a/d1/database/b/query",
			{
				label: "POST /accounts/a/d1/database/b/query",
				attempts: 9,
				elapsedMs: 44_310,
				queuedMs: 40_000,
				backoffMs: 3_800,
				budgetMs: 45_000,
				reason: "max-retries",
			},
			'{"code":971}',
		);
		expect(isCfRateLimit(err)).toBe(true);
		expect(err.message).toContain("POST /accounts/a/d1/database/b/query");
		expect(err.message).toContain("9 attempts");
		expect(err.message).toContain("44310ms");
		expect(err.message).toContain("971");
		// The round-2 attribution: WHY it stopped, and how the elapsed time split — so a repeat of
		// PR #4033's ejection reads as "queued in our own throttle" off the log line itself.
		expect(err.message).toContain("max-retries");
		expect(err.message).toContain("40000ms queued in the harness's own throttle");
		expect(err.message).toContain("4310ms of the 45000ms CF-facing retry budget");
		// A non-429 failure must NEVER be classified as a rate-limit and retried into a fake pass.
		expect(isCfRateLimit(new Error("D1_ERROR: no such table"))).toBe(false);
	});
});

// The data-plane fix (#3099): the `restLayer` transport's fetch is wrapped so a data-plane D1 REST
// call retries a 429 at the transport, before `queryDatabase` maps a settled 429 to a thrown error.
describe("rateLimitRetryingFetch — 429-resilient restLayer transport", () => {
	// A base fetch yielding the given statuses in order (last repeats); a 200 carries a valid
	// D1 REST body so `makeD1Rest` can parse it. Records how many sends the wrapper made.
	const baseFetch = (statuses: number[]) => {
		let i = 0;
		return vi.fn(async () => {
			const status = statuses[Math.min(i++, statuses.length - 1)]!;
			if (status === CF_RATE_LIMIT_STATUS) return new Response("429", {status});
			return new Response(
				JSON.stringify({result: [{meta: {changes: 1}, results: [], success: true}]}),
				{
					status,
					headers: {"content-type": "application/json"},
				},
			);
		});
	};

	it("resends a data-plane 429 through the base fetch until it settles 200", async () => {
		const base = baseFetch([429, 429, 200]);
		const res = await rateLimitRetryingFetch(base, {sleep: noSleep, random: () => 0.5})(
			"https://example.test/query",
		);
		expect(res.status).toBe(200);
		expect(base).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	it("drives a makeD1Rest query through a 429→200 fetch WITHOUT throwing (the #3099 hard-fail)", async () => {
		const base = baseFetch([429, 200]);
		const db = makeD1Rest({
			accountId: "acc",
			databaseId: "db",
			layer: Layer.mergeAll(
				FetchHttpClient.layer.pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, rateLimitRetryingFetch(base, {sleep: noSleep})),
					),
				),
				fromApiToken({apiToken: "test-token"}),
			),
		});
		// Without the wrapper the 429 would surface as a thrown error and reject this run.
		const res = await db.prepare("update x set y = ? where z = ?").bind("a", "b").run();
		expect(res.meta.changes).toBe(1);
		expect(base).toHaveBeenCalledTimes(2); // 429 retried, then the settled 200
	});
});
