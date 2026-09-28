/**
 * Pins the two properties that make `_cf-rest-transport.ts` the ONE CF REST path (#3548):
 * the composition releases its throttle slot while backing off, and no file in the integration
 * directory can quietly re-introduce a bare, unprotected REST client.
 */

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {CF_API_MAX_CONCURRENT, cfApiThrottle} from "./_cf-api-throttle.ts";
import {cfRestSend} from "./_cf-rest-transport.ts";
import type {RateLimitAttrition} from "./_d1-rest-retry.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url).href);

const rateLimited = async () => new Response("429", {status: 429});

// Both cases drive the shipped `cfRestSend` over the process-wide `cfApiThrottle`, so a change to
// how the transport composes the two halves is what they catch — not a composition rebuilt here.
describe("retry composes AROUND the throttle (a slot is held per attempt, not per logical call)", () => {
	it("lets another call through while every slot's 429 is backing off", async () => {
		// Fill every slot with a call whose backoff sleep waits for a later call to run. Under
		// #3081's original order — `throttle.run(() => retry(send))` — each backing-off call keeps
		// its slot, the later call never starts, and this test HANGS to its timeout. Completing is
		// the assertion; the expects below confirm no call was corrupted on the way.
		let releaseBackoff = () => {};
		const laterCallRan = new Promise<void>((r) => {
			releaseBackoff = r;
		});
		const backingOff = Array.from({length: CF_API_MAX_CONCURRENT}, () =>
			cfRestSend(rateLimited, {maxRetries: 1, sleep: () => laterCallRan, onGiveUp: () => {}}),
		);
		const later = cfApiThrottle.run(async () => {
			releaseBackoff();
			return new Response("ok", {status: 200});
		});

		const [laterRes, ...backedOff] = await Promise.all([later, ...backingOff]);
		expect(laterRes.status).toBe(200);
		expect(backedOff.map((r) => r.status)).toEqual(backingOff.map(() => 429));
	});

	// The cost of holding a slot per ATTEMPT: a logical call re-enters the harness's queue on every
	// retry. PR #4033's merge-queue ejection was that cost billed to the wrong account — "2 attempts
	// over 45136ms of retry budget", ~44.6s of which was throttle queueing, so the CF-facing budget
	// expired having asked Cloudflare twice. The throttle's `onQueued` must reach the retry's sink.
	it("reports the throttle's own queueing into the retry's attrition", async () => {
		const attrition: RateLimitAttrition[] = [];
		const res = await cfRestSend(rateLimited, {
			maxRetries: 3,
			sleep: async () => {},
			onGiveUp: (a) => attrition.push(a),
		});
		expect(res.status).toBe(429);
		// Four sends, each start paced after the last by the throttle's minimum spacing: that wait
		// is harness-imposed, so it must be booked as queued rather than charged to Cloudflare.
		expect(attrition[0]?.reason).toBe("max-retries");
		expect(attrition[0]?.attempts).toBe(4);
		expect(attrition[0]?.queuedMs).toBeGreaterThan(0);
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

	it("finds no bare CF REST client in any of them", () => {
		// Fail closed on zero scope (ADR 0092): an empty directory read would pass the scan below.
		expect(files.length).toBeGreaterThan(0);
		const offenders = files.flatMap((file) => {
			const src = readFileSync(`${HERE}${file}`, "utf8");
			return BARE.filter(([re]) => re.test(src)).map(([, why]) => `${file}: ${why}`);
		});
		expect(offenders).toEqual([]);
	});
});
