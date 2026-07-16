/**
 * Shared harness-level throttle for the setup-side Cloudflare API surface — a concurrency
 * cap + full-jitter minimum spacing that every harness-initiated CF REST call funnels
 * through, so the harness's OWN aggregate CF API pressure stays smoothed under the
 * account-global rate limit (HTTP 429, error code 971 "TooManyRequests"; #3081).
 *
 * Relationship to the existing per-call retry (`cfFetchWithRateLimitRetry`, `_d1-rest-retry.ts`):
 * that wrapper reacts to a 429 AFTER it fires, replaying one call with backoff. This throttle
 * is the complementary PROACTIVE half — it bounds how many CF calls the harness launches at
 * once and paces their starts, so fewer 429s fire in the first place. It COMPOSES AROUND the
 * per-call retry (`throttle.run(() => cfFetchWithRateLimitRetry(send))`), never replacing it —
 * each logical CF call, retries included, counts as one throttled unit.
 *
 * Scope ceiling (deliberate, per #3081's "confined to the integration harness" constraint):
 * the limiter is an in-process singleton, so under `isolate:false` (`vitest.config.ts`) it is
 * shared across every file that runs in the SAME fork and genuinely paces their combined setup
 * D1 REST burst. It does NOT coordinate across forks or across separate CI runs — the observed
 * "~24 concurrent" pressure is a CROSS-run aggregate (~4 overlapping `merge_group` runs on the
 * one account, #3081 evidence), which no in-harness code can reach. The cross-run levers named
 * in #3081 live outside this harness: a GitHub Actions `concurrency:` group (a workflow change)
 * and 429 backoff inside alchemy's own deploy path (a `pnpm patch`, ADR 0038). This throttle is
 * the run-agnostic backoff applied to the slice the harness DOES own — its own D1 REST calls.
 *
 * A pure leaf: `sleep` / `now` / `random` are injectable, no `fetch`/creds dependency, so the
 * pacing logic is unit-testable offline (matches `_d1-rest-retry.ts` / `_deploy-transient.ts`).
 */

/** Max CF API calls this throttle keeps in flight at once (tunable via env). */
export const CF_API_MAX_CONCURRENT = 4;
/** Minimum full-jitter gap between successive CF API call starts, ms (tunable via env). */
export const CF_API_MIN_SPACING_MS = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CfApiThrottleOptions {
	/** Cap on concurrently in-flight calls (default {@link CF_API_MAX_CONCURRENT}). */
	maxConcurrent?: number;
	/** Minimum spacing between call starts, ms (default {@link CF_API_MIN_SPACING_MS}). */
	minSpacingMs?: number;
	/** Injected for tests — real sleep by default. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected for tests — `Date.now` by default. */
	now?: () => number;
	/** Injected for tests — `Math.random` by default. */
	random?: () => number;
}

export interface CfApiThrottle {
	/** Run `op` under the concurrency cap + start-pacing; resolves/rejects with `op`'s result. */
	run<T>(op: () => Promise<T>): Promise<T>;
}

/**
 * Build a throttle enforcing (1) a max in-flight count and (2) a minimum full-jitter gap
 * between call starts. Both knobs are independently disable-able: `maxConcurrent = Infinity`
 * drops the cap, `minSpacingMs = 0` drops the pacing.
 */
export const createCfApiThrottle = ({
	maxConcurrent = CF_API_MAX_CONCURRENT,
	minSpacingMs = CF_API_MIN_SPACING_MS,
	sleep = defaultSleep,
	now = () => Date.now(),
	random = Math.random,
}: CfApiThrottleOptions = {}): CfApiThrottle => {
	let inFlight = 0;
	const waiters: Array<() => void> = [];
	// Earliest timestamp the NEXT call may start — advanced synchronously as each call
	// reserves its slot, so staggered runners de-sync instead of firing as one packet.
	let nextStartFloor = 0;

	const acquireSlot = async (): Promise<void> => {
		if (inFlight >= maxConcurrent) await new Promise<void>((resolve) => waiters.push(resolve));
		inFlight++;
	};
	const releaseSlot = (): void => {
		inFlight--;
		waiters.shift()?.();
	};

	// Full-jitter start pacing: reserve a start no earlier than `minSpacingMs` past the prior
	// reservation, plus a uniform jitter in [0, minSpacingMs). The reservation (reading `now`,
	// bumping `nextStartFloor`) is synchronous, so concurrent runners each claim a distinct,
	// monotonically-spaced start before any of them awaits — the same anti-thundering-herd
	// discipline `cfFetchWithRateLimitRetry`'s retry jitter applies, here to first attempts.
	const pace = async (): Promise<void> => {
		if (minSpacingMs <= 0) return;
		const start = Math.max(nextStartFloor, now()) + Math.floor(random() * minSpacingMs);
		nextStartFloor = start + minSpacingMs;
		const wait = start - now();
		if (wait > 0) await sleep(wait);
	};

	return {
		async run<T>(op: () => Promise<T>): Promise<T> {
			await acquireSlot();
			try {
				await pace();
				return await op();
			} finally {
				releaseSlot();
			}
		},
	};
};

// Read a positive numeric tunable from the env, else the default — lets an operator widen or
// tighten the harness's self-imposed CF-API ceiling without a code change (the single-account
// budget is a fixed ceiling to MANAGE, not a stopgap; #3081 founder constraint).
const envNumber = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The process-wide shared throttle every harness CF REST call funnels through
 * (`_harness.ts`'s `cloudflareApi`). One instance per fork under `isolate:false`, so all
 * files sharing a fork share this limiter's state.
 */
export const cfApiThrottle: CfApiThrottle = createCfApiThrottle({
	maxConcurrent: envNumber("CF_API_MAX_CONCURRENT", CF_API_MAX_CONCURRENT),
	minSpacingMs: envNumber("CF_API_MIN_SPACING_MS", CF_API_MIN_SPACING_MS),
});
