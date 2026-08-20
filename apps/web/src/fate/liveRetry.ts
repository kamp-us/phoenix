/** The client half of ADR 0095's cold-start handling. */

/** Bounded budget for ONE connectivity window; `rearm` restores it. */
export const LIVE_RETRY_MAX_ATTEMPTS = 5;

const LIVE_RETRY_BASE_MS = 250;
const LIVE_RETRY_CAP_MS = 5000;

/**
 * `.status === 503` is the only discriminant that survives fate's transport: for an
 * HTTP-delivered `liveError("LIVE_UNAVAILABLE", …, 503)`, `responseError`
 * (`@nkzw/fate`) derives `.code` from the status (`errorCodeFromStatus(503)` →
 * `"INTERNAL_ERROR"`) and discards the payload code, so keying on the code alone would
 * silently never match. The `LIVE_UNAVAILABLE` arm covers the in-band protocol-frame
 * path, where `protocolError` does preserve the server code.
 */
export function isTransientLiveError(error: unknown): boolean {
	if (error == null || typeof error !== "object") return false;
	const {status, code} = error as {status?: unknown; code?: unknown};
	return status === 503 || code === "LIVE_UNAVAILABLE";
}

/** `attempt` is the count of attempts already made (0-indexed). */
export function nextLiveRetryDelayMs(attempt: number): number {
	const exp = LIVE_RETRY_BASE_MS * 2 ** Math.max(0, attempt);
	return Math.min(exp, LIVE_RETRY_CAP_MS);
}

export interface RetryTimers {
	readonly setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LiveRetryController {
	readonly schedule: (fireRetry: () => void) => void;
	/**
	 * Re-arm a SPENT budget and reconnect immediately, driven from
	 * `online`/`visibilitychange` (#3790). A no-op while attempts remain: the in-flight
	 * back-off already owns recovery, and re-arming mid-window would reset its progress
	 * on every benign tab focus.
	 */
	readonly rearm: (fireRetry: () => void) => void;
	readonly cancel: () => void;
	readonly reset: () => void;
}

/**
 * The invariant: the budget counts CONNECT attempts, not error fan-out. One failed cold
 * connect fires `onLiveError` once PER mounted subscription (fate loops all
 * `liveSubscriptions`), so charging per error drains the budget ~N× faster on a page
 * with N live views and exhausts it before the DO warms (#1738).
 */
export function createLiveRetryController(
	timers: RetryTimers = {setTimeout, clearTimeout},
): LiveRetryController {
	let attempt = 0;
	let pending: ReturnType<typeof setTimeout> | null = null;

	const drop = () => {
		if (pending != null) {
			timers.clearTimeout(pending);
			pending = null;
		}
	};

	return {
		schedule: (fireRetry) => {
			// Coalesce the error burst: one connect failure must cost only one attempt.
			if (pending != null) return;
			if (attempt >= LIVE_RETRY_MAX_ATTEMPTS) return;
			const delay = nextLiveRetryDelayMs(attempt);
			attempt += 1;
			pending = timers.setTimeout(() => {
				// Clear BEFORE firing so the next failed connect's burst can schedule again.
				pending = null;
				fireRetry();
			}, delay);
		},
		rearm: (fireRetry) => {
			// `drop()` below is defensive — a spent budget holds no pending timer.
			if (attempt < LIVE_RETRY_MAX_ATTEMPTS) return;
			drop();
			attempt = 0;
			fireRetry();
		},
		cancel: drop,
		reset: () => {
			attempt = 0;
			drop();
		},
	};
}
