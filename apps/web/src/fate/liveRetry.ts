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
