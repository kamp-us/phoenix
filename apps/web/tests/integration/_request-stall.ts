/**
 * Stall attribution + recovery for the integration harness's worker-HTTP path (#3942).
 *
 * A "stall" is one request that never answered within `REQUEST_TIMEOUT_MS` and was aborted
 * by `AbortSignal.timeout` — distinct from a connection error (which never reached the
 * worker) and from a slow-but-answering round-trip. Measured against the real remote stage,
 * a healthy round-trip is nowhere near the bound: in merge-queue batch run `30143777821` the
 * 206-test suite had p50 462ms / p90 1698ms / p99 2842ms per TEST (each several round-trips),
 * and the slowest PASSING test was 5616ms. A request that reaches 30s is therefore stalled,
 * not slow — so the recovery for it is a REPLAY, never a wider budget (a wider budget only
 * delays the same failure, and past the 120s `testTimeout` it degrades into the opaque
 * "Hook timed out" / "All fibers interrupted" shape).
 *
 * Two things were missing at the seam and are supplied here:
 *
 *   1. **Attribution.** The raw `TimeoutError` escaped naked — CI printed a `DOMException`
 *      code dump with no method, no path, no stack, so a flake could only be GUESSED at
 *      (the #3942 report guessed SSE; the test opens no SSE stream). {@link RequestStallError}
 *      names the round-trip that stalled, so the next occurrence is diagnosable instead of
 *      re-litigated.
 *   2. **Recovery for the two honest cases.** {@link isSafeMethod} derives replay-safety from
 *      the REQUEST (RFC 9110 §9.2.1/§9.2.2 — GET/HEAD are safe and idempotent, so a stalled
 *      one cannot have applied a write and is always sound to replay), rather than making
 *      every caller assert it. {@link convergeAfterStall} covers the case a replay CANNOT
 *      cover — a non-idempotent mutation, where a stall leaves it genuinely unknown whether
 *      the write landed: re-send only after PROVING it did not, by probing for the landed
 *      row and adopting it if present.
 *
 * A pure leaf — no `fetch`, no creds, injectable `sleep` — so the policy is unit-testable
 * offline, matching `_d1-rest-retry.ts` / `_cf-api-throttle.ts` / `_edge-ready.ts`.
 */

/**
 * A request that was aborted by its per-request timeout, carrying WHICH round-trip stalled.
 * Thrown in place of the bare `TimeoutError` so a CI failure names the seam.
 */
export class RequestStallError extends Error {
	readonly _tag = "RequestStall";
	readonly method: string;
	readonly path: string;
	readonly timeoutMs: number;
	readonly attempts: number;
	constructor(method: string, path: string, timeoutMs: number, attempts: number) {
		super(
			`request stalled: ${method} ${path} did not answer within ${timeoutMs}ms ` +
				`(${attempts} attempt${attempts === 1 ? "" : "s"})`,
		);
		this.name = "RequestStallError";
		this.method = method;
		this.path = path;
		this.timeoutMs = timeoutMs;
		this.attempts = attempts;
	}
}

/**
 * Is this a stall (the abort a per-request timeout fires), as opposed to a connection error
 * or a real failure? Matches both the raw `AbortSignal.timeout` rejection and the attributed
 * {@link RequestStallError} it is re-thrown as, so a caller downstream of `req` classifies
 * the same event identically whichever form reaches it.
 */
export const isStall = (e: unknown): boolean =>
	e instanceof RequestStallError ||
	(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));

/**
 * Is the method SAFE (RFC 9110 §9.2.1) and therefore idempotent (§9.2.2)? A stalled GET/HEAD
 * applied no state change whatever the origin did with it, so replaying it on a fresh
 * connection is sound by the HTTP contract — no caller assertion required. Every other method
 * (POST above all) may have committed before the response was lost, so it is NOT replayable
 * here; it goes to {@link convergeAfterStall} or surfaces.
 */
export const isSafeMethod = (method: string | undefined): boolean => {
	const m = (method ?? "GET").toUpperCase();
	return m === "GET" || m === "HEAD";
};

/**
 * Replays allowed for a stalled safe request, on top of the first attempt.
 *
 * Held at 1 deliberately: each attempt can consume the full per-request timeout, so a worst
 * case of two 30s attempts is 60s — half the 120s `testTimeout`, which is the room the
 * harness's own sizing note budgets for a retry. A larger cap would let a pathological stall
 * chain past the test budget and resurface as the opaque vitest timeout this recovery exists
 * to prevent.
 */
export const SAFE_STALL_REPLAYS = 1;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ConvergeOptions {
	attempts?: number;
	backoffMs?: number;
	/**
	 * Which thrown failures the landed-probe recovers. Default: only a stall — a real error
	 * (a rejected mutation, a connection failure) surfaces at once and is never retried into
	 * a duplicate write. A caller whose op is pure setup may widen it.
	 */
	recoverable?: (e: unknown) => boolean;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a NON-idempotent mutation so that a stall converges instead of hard-failing.
 *
 * The stall leaves exactly one thing unknown — did the write land? So resolve it rather than
 * guess: probe with `landed()`; a present result is ADOPTED (the write committed, only its
 * response was lost), an absent one proves the write did not apply and the send is re-issued.
 * That is what makes this safe where a blind replay is not, and it is the only recovery shape
 * available to a protocol with no client idempotency key.
 *
 * `send` resolving is always terminal — a domain-level `!ok` is a real answer a test asserts
 * on, never a transient to retry (widen `recoverable` only for pure seeding, where any
 * failure is worth a probe).
 */
export const convergeAfterStall = async <T>(
	send: () => Promise<T>,
	landed: () => Promise<T | undefined>,
	{
		attempts = 3,
		backoffMs = 400,
		recoverable = isStall,
		sleep = defaultSleep,
	}: ConvergeOptions = {},
): Promise<T> => {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await send();
		} catch (err) {
			if (!recoverable(err)) throw err;
			lastErr = err;
		}
		const adopted = await landed();
		if (adopted !== undefined) return adopted;
		if (i < attempts - 1) await sleep(backoffMs * (i + 1));
	}
	throw lastErr;
};
