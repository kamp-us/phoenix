/**
 * Pins the two properties that make `_cf-rest-transport.ts` the ONE CF REST path (#3548):
 * the composition releases its throttle slot while backing off, and no integration test file
 * can quietly re-introduce a bare, unprotected REST client.
 */

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {createCfApiThrottle} from "./_cf-api-throttle.ts";
import {cfFetchWithRateLimitRetry} from "./_d1-rest-retry.ts";

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
});

// The #3548 bypass was structural, not a typo: #3099 wrapped the two files that happened to be
// failing, leaving every other file on `Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)` —
// the bare fetch, no retry, no throttle. `pasaport-ban.test.ts` then red on a raw
// `TooManyRequests` while its wrapped sibling sailed through the same 429 storm. Converting the
// files fixes today; this scan is what keeps the next file from re-opening the hole.
describe("no integration test builds its own unprotected CF REST client", () => {
	// This file and `_d1-rest-retry.unit.test.ts` exercise the bare primitives on purpose.
	const EXEMPT = new Set(["_cf-rest-transport.unit.test.ts", "_d1-rest-retry.unit.test.ts"]);
	const BARE = [
		[/FetchHttpClient\.layer/, "hand-rolled REST layer — use `integrationRestLayer`"],
		[/makeD1RestFromEnv/, "bare env layer — use `makeIntegrationD1Rest`"],
	] as const;

	const files = readdirSync(HERE).filter((f) => f.endsWith(".test.ts") && !EXEMPT.has(f));

	it("scans a non-empty set of integration test files (fail closed on zero scope, ADR 0092)", () => {
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
