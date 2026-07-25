/**
 * Pins the two properties that make `_cf-rest-transport.ts` the ONE CF REST path (#3548):
 * the composition releases its throttle slot while backing off, and no file in the integration
 * directory can quietly re-introduce a bare, unprotected REST client.
 */

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {createCfApiThrottle} from "./_cf-api-throttle.ts";
import {
	budgetSpentMs,
	cfFetchWithRateLimitRetry,
	type RateLimitAttrition,
} from "./_d1-rest-retry.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url).href);

describe("retry composes AROUND the throttle (a slot is held per attempt, not per logical call)", () => {
	it("lets another call through while a 429 is backing off", async () => {
		// Under #3081's original order — `throttle.run(() => retry(send))` — the backing-off call
		// keeps the only slot, so `second` never starts, `releaseSecond` is never called, and this
		// test HANGS to its timeout. Completing is the assertion; the expects below just confirm
		// neither call was corrupted on the way.
		const throttle = createCfApiThrottle({maxConcurrent: 1, minSpacingMs: 0});
		let releaseSecond = () => {};
		const secondRan = new Promise<void>((r) => {
			releaseSecond = r;
		});

		const first = cfFetchWithRateLimitRetry(
			() => throttle.run(async () => new Response("429", {status: 429})),
			{maxRetries: 2, sleep: () => secondRan, random: () => 0, now: () => 0, onGiveUp: () => {}},
		);
		const second = throttle.run(async () => {
			releaseSecond();
			return new Response("ok", {status: 200});
		});

		const [firstRes, secondRes] = await Promise.all([first, second]);
		expect(firstRes.status).toBe(429);
		expect(secondRes.status).toBe(200);
	});

	// The cost of holding a slot per ATTEMPT: a logical call re-enters the harness's queue on every
	// retry. PR #4033's merge-queue ejection was that cost billed to the wrong account — "2 attempts
	// over 45136ms of retry budget", ~44.6s of which was throttle queueing, so the CF-facing budget
	// expired having asked Cloudflare twice. The throttle's `onQueued` must reach the retry's sink.
	it("deducts the throttle's own queueing from the CF-facing retry budget", async () => {
		let clock = 0;
		const throttle = createCfApiThrottle({
			maxConcurrent: 10,
			minSpacingMs: 1000, // each start is paced a full second apart — pure harness-imposed wait
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
			random: () => 0,
		});
		const attrition: RateLimitAttrition[] = [];
		const res = await cfFetchWithRateLimitRetry(
			(queued) => throttle.run(async () => new Response("429", {status: 429}), queued),
			{
				budgetMs: 2000,
				baseDelayMs: 10,
				maxRetries: 3,
				random: () => 0,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				onGiveUp: (a) => attrition.push(a),
			},
		);
		expect(res.status).toBe(429);
		// Without the deduction the 1000ms-per-attempt pacing alone exhausts a 2000ms budget in two
		// sends; with it, the runaway guard is what stops the loop and the budget is barely touched.
		expect(attrition[0]?.reason).toBe("max-retries");
		expect(attrition[0]?.attempts).toBe(4);
		expect(attrition[0]?.queuedMs).toBeGreaterThanOrEqual(3000);
		expect(budgetSpentMs(attrition[0] as RateLimitAttrition)).toBeLessThan(2000);
	});
});

// The #3548 bypass was structural, not a typo: #3099 wrapped the two files that happened to be
// failing, leaving every other file on `Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)` —
// the bare fetch, no retry, no throttle. `pasaport-ban.test.ts` then red on a raw
// `TooManyRequests` while its wrapped sibling sailed through the same 429 storm. Converting the
// files fixes today; this scan is what keeps the next file from re-opening the hole.
describe("no integration file builds its own unprotected CF REST client", () => {
	// `_cf-rest-transport.ts` IS the protected transport (it owns the one legitimate
	// `FetchHttpClient.layer`); this file and `_d1-rest-retry.unit.test.ts` exercise the bare
	// primitives on purpose.
	const EXEMPT = new Set([
		"_cf-rest-transport.ts",
		"_cf-rest-transport.unit.test.ts",
		"_d1-rest-retry.unit.test.ts",
	]);
	const BARE = [
		[/FetchHttpClient\.layer/, "hand-rolled REST layer — use `integrationRestLayer`"],
		// Call-shaped on purpose: `_harness.ts` names `makeD1RestFromEnv` in prose, and a scan
		// that reds on a comment is a scan people delete.
		[/makeD1RestFromEnv\s*\(/, "bare env layer — use `makeIntegrationD1Rest`"],
	] as const;

	// Every `.ts` in the directory, not just `*.test.ts`: a non-test helper that grew its own
	// client would reopen the bypass just as wide, and unscanned.
	const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f));

	it("scans a non-empty set of integration files (fail closed on zero scope, ADR 0092)", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("finds no bare CF REST client in any of them", () => {
		const offenders = files.flatMap((file) => {
			const src = readFileSync(`${HERE}${file}`, "utf8");
			return BARE.filter(([re]) => re.test(src)).map(([, why]) => `${file}: ${why}`);
		});
		expect(offenders).toEqual([]);
	});
});
