/**
 * Shared harness-level throttle for the setup-side Cloudflare API surface — a concurrency
 * cap + full-jitter minimum spacing that every harness-initiated CF REST call funnels
 * through, so the harness's OWN aggregate CF API pressure stays smoothed under the
 * account-global rate limit (HTTP 429, error code 971 "TooManyRequests"; #3081).
 *
 * Relationship to the existing per-call retry (`cfFetchWithRateLimitRetry`, `_d1-rest-retry.ts`):
 * that wrapper reacts to a 429 AFTER it fires, replaying one call with backoff. This throttle
 * is the complementary PROACTIVE half — it bounds how many CF calls the harness launches at
 * once and paces their starts, so fewer 429s fire in the first place. The retry composes AROUND
 * this throttle (`retry(() => throttle.run(send))`), never replacing it — a slot is held per
 * ATTEMPT and released while a call sleeps in backoff, so a backing-off call never occupies the
 * concurrency cap. That order is wired in exactly one place, `_cf-rest-transport.ts`; see its
 * docblock for why #3081's original one-throttled-unit-per-logical-call order was inverted (#3548).
 *
 * **A sleeping call is not in flight — and that binds start-pacing too (#3548).** `pace()` used to
 * sleep INSIDE the slot, so the start-pacer's own waiting occupied the concurrency cap and the
 * throttle's throughput collapsed toward one call per `minSpacingMs` per slot. Pacing is a RATE
 * limit and the semaphore is a CONCURRENCY limit; nesting the two conflates them. `pace()` runs
 * BEFORE `acquireSlot()`, exactly as backoff sleeps run outside it.
 *
 * Both knobs are also honest about their cost: whatever a caller waits here is time the HARNESS
 * imposed, not time Cloudflare spent rate-limiting it, so `run` reports it through `onQueued` and
 * the retry deducts it from its CF-facing budget (see `_d1-rest-retry.ts`).
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
 */

/** Max CF API calls this throttle keeps in flight at once (tunable via env). */
export const CF_API_MAX_CONCURRENT = 4;
/** Minimum full-jitter gap between successive CF API call starts, ms (tunable via env). */
export const CF_API_MIN_SPACING_MS = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CfApiThrottleOptions {
	maxConcurrent?: number;
	minSpacingMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
}

export interface CfApiThrottle {
	/**
	 * Run `op` under the start-pacing + concurrency cap; resolves/rejects with `op`'s result.
	 * `onQueued` is called once, just before `op` starts, with the ms this call spent waiting for
	 * its paced start and its slot — harness-imposed latency the caller may want to account for
	 * separately from time Cloudflare kept it waiting.
	 */
	run<T>(op: () => Promise<T>, onQueued?: (ms: number) => void): Promise<T>;
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

	// The slot is HANDED OVER on release rather than decremented-then-reacquired: the old
	// `inFlight--; waiters.shift()?.()` left a window where a fresh caller could synchronously
	// observe a free slot and take it while the woken waiter also incremented — so `inFlight`
	// could exceed `maxConcurrent` and the cap silently stopped binding under exactly the
	// contention it exists for.
	const acquireSlot = async (): Promise<void> => {
		if (inFlight < maxConcurrent) {
			inFlight++;
			return;
		}
		await new Promise<void>((resolve) => waiters.push(resolve)); // resumed holding the slot
	};
	const releaseSlot = (): void => {
		const next = waiters.shift();
		if (next) next();
		else inFlight--;
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
		async run<T>(op: () => Promise<T>, onQueued?: (ms: number) => void): Promise<T> {
			const queuedFrom = now();
			await pace(); // outside the slot: a call sleeping until its reserved start is not in flight
			await acquireSlot();
			onQueued?.(now() - queuedFrom);
			try {
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
