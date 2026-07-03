/**
 * The client half of ADR 0095's cold-start handling: classify a live-error as the
 * server's graceful cold-start back-off signal, and compute the bounded retry
 * back-off the global live pin (ADR 0094) re-attempts the connect on.
 *
 * The server renders an exhausted cold-DO retry as `liveError("LIVE_UNAVAILABLE",
 * …, 503)`. By the time that envelope reaches the SPA, fate's transport has
 * rebuilt it: `responseError` (`@nkzw/fate`) constructs a `FateRequestError` whose
 * `.code` is derived from the HTTP *status* (`errorCodeFromStatus(503)` →
 * `"INTERNAL_ERROR"`), discarding the payload's `LIVE_UNAVAILABLE` code and keeping
 * only the message. So the one discriminant that survives the transport is
 * `.status === 503` — keying on the `code` would silently never match. We also
 * accept an explicit `LIVE_UNAVAILABLE` code for the in-band protocol-frame path
 * (`handleLiveMessage` → `protocolError` *does* preserve the server code), so both
 * delivery shapes of the same server signal are covered.
 */

/** Bounded retry budget — past this the pin stops re-attempting for the session. */
export const LIVE_RETRY_MAX_ATTEMPTS = 5;

const LIVE_RETRY_BASE_MS = 250;
const LIVE_RETRY_CAP_MS = 5000;

/**
 * True iff `error` is the server's transient cold-start back-off signal — a graceful
 * `LIVE_UNAVAILABLE`/503, never a genuine app error. A real 4xx/app error (status
 * 400/401/403/404) or a defect-500 (status 500, code `INTERNAL_ERROR`) returns
 * false, so it is NOT retried as transient and stays on the `console.error` surface.
 */
export function isTransientLiveError(error: unknown): boolean {
	if (error == null || typeof error !== "object") return false;
	const {status, code} = error as {status?: unknown; code?: unknown};
	return status === 503 || code === "LIVE_UNAVAILABLE";
}

/**
 * Capped exponential back-off for the next connect re-attempt. `attempt` is the
 * count of attempts already made (0-indexed): 250, 500, 1000, 2000, 4000 ms, capped
 * at 5000. Comfortably spans the sub-second DO warm window across a few mounts.
 */
export function nextLiveRetryDelayMs(attempt: number): number {
	const exp = LIVE_RETRY_BASE_MS * 2 ** Math.max(0, attempt);
	return Math.min(exp, LIVE_RETRY_CAP_MS);
}

/** Injectable timer seam so the budget/coalescing invariant is testable off real time. */
export interface RetryTimers {
	readonly setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LiveRetryController {
	/**
	 * Ask for a bounded back-off reconnect. Coalesces a BURST of transient errors
	 * from one failed connect into a single scheduled retry, and runs `fireRetry`
	 * (the reconnect trigger) once the back-off elapses. A call while a retry is
	 * already pending, or once the budget is spent, is a no-op.
	 */
	readonly schedule: (fireRetry: () => void) => void;
	/** Cancel a pending retry without firing it (unmount). */
	readonly cancel: () => void;
	/** Restore the full budget and drop any pending retry (new session identity). */
	readonly reset: () => void;
}

/**
 * The bounded cold-start reconnect budget (ADR 0095), extracted from `FateProvider`
 * so its coalescing invariant is unit-testable off the React tree.
 *
 * The invariant: the budget counts CONNECT attempts, not error fan-out. One failed
 * (cold) live connect fans its error out to EVERY mounted live subscription — fate's
 * native client loops all `liveSubscriptions` on a connection error, so the client's
 * `onLiveError` fires once PER subscription, not once per connect. Charging the budget
 * per error drains the N-attempt budget ~N× faster on a page with N live views,
 * exhausting it before the DO warms — the #1738 post-reconnect defect, where a
 * post-detail page (pin + header + comments live views) burned the 5-attempt budget in
 * ~2 cold connects and never re-established the stream, so a vote published after the
 * reload never reached the reconnected client. Coalescing the burst behind a single
 * `pending` timer makes each cold connect cost exactly one attempt, so the five
 * back-offs span five real reconnects (~7.75s) — long enough to outlast a cold DO.
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
			// A retry is already scheduled for this failed connect → coalesce the error
			// burst; the fan-out of one connect failure must cost only one attempt.
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
		cancel: drop,
		reset: () => {
			attempt = 0;
			drop();
		},
	};
}
