/**
 * Bounded retry for the integration harness's Cloudflare D1 REST path against a transient
 * rate-limit (HTTP 429, error code 971 "TooManyRequests").
 *
 * The per-file-stage integration model (ADR 0082) hammers ONE Cloudflare account's D1
 * control-plane REST (`/d1/database/<id>/query`) from ~24 parallel stages, and several
 * `merge_group` runs overlap on that one account. A 429 is the CF gateway REJECTING the
 * request before it executes — no partial write — so replay is safe by construction; the same
 * class is already treated transient-retryable at the DEPLOY layer (`_deploy-transient.ts`).
 *
 * **The budget is wall-clock, not an attempt count (#3548).** #2915 sized this as "5 retries
 * with full-jitter backoff", which makes the real budget a RANDOM VARIABLE: each wait is
 * uniform over `[0, base·2^attempt)`, so five retries average 7.75s of waiting but can burn
 * out in under a second. Measured in the ejecting run `29665891972`, account-global 429
 * pressure ran from 23:52:18 to 23:57:08 — a ~290s plateau, two orders of magnitude past that
 * budget — so the shipped retry ran, exhausted, and red five bystander suites anyway. The
 * budget is therefore a DEADLINE (`budgetMs`): keep re-sending while wall-clock budget remains,
 * with the attempt cap demoted to a runaway guard. Full jitter is retained per-wait (it is what
 * de-syncs the parallel stages), it just no longer decides when to give up.
 *
 * Scoped to 429 ONLY: a real SQL error surfaces as a 200-with-`errors[]` (classified by
 * `runD1Query`), and a genuine API error as a non-429 4xx/5xx — neither is a 429, so neither is
 * retried and a real failure still surfaces at once, undelayed. Exhaustion returns the final
 * 429 for the caller to raise; this wrapper never converts a failure into a success.
 *
 * A pure leaf (injectable `send`/`sleep`/`random`/`now`, no `fetch`/creds dependency) so the
 * retry logic is unit-testable offline. The throttle+retry COMPOSITION lives in one place,
 * `_cf-rest-transport.ts` — not here.
 */

export const CF_RATE_LIMIT_STATUS = 429;

/**
 * Wall-clock retry budget per logical CF REST call. Sized against the two live constraints:
 * above the ~8s the old attempt-count budget averaged, and comfortably under `vitest.config.ts`'s
 * 120s `testTimeout` — a budget that outran the test timeout would trade a named 429 for the
 * opaque "Hook timed out" shape (the failure mode `_request-stall.ts` documents).
 */
export const D1_REST_BUDGET_MS = 45_000;
/** Runaway guard only — the deadline above is what normally ends the loop. */
export const D1_REST_MAX_RETRIES = 24;
export const D1_REST_BASE_DELAY_MS = 500;
/** Ceiling on a single backoff wait, so one long wait can't swallow the whole budget. */
export const D1_REST_MAX_DELAY_MS = 8_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a call spent before giving up — the payload that makes an exhausted 429 diagnosable. */
export interface RateLimitAttrition {
	/** Caller-supplied name of the round-trip (method + path), for the log line. */
	readonly label: string;
	/** Total sends, including the first attempt. */
	readonly attempts: number;
	/** Wall-clock ms from the first send to giving up. */
	readonly elapsedMs: number;
}

/**
 * A CF REST call that stayed rate-limited for its whole budget, carrying WHICH call it was and
 * what it spent. Thrown in place of a bare "failed: 429 <body>" so the next occurrence names the
 * rate-limited round-trip and its attrition instead of being re-diagnosed from scratch (#3548,
 * the same attribution `RequestStallError` gives the worker-HTTP stall path).
 */
export class CfRateLimitError extends Error {
	readonly _tag = "CfRateLimit";
	readonly method: string;
	readonly path: string;
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly body: string;
	constructor(method: string, path: string, attrition: RateLimitAttrition, body: string) {
		super(
			`Cloudflare API ${method} ${path} rate-limited (HTTP 429, code 971): gave up after ` +
				`${attrition.attempts} attempt${attrition.attempts === 1 ? "" : "s"} over ` +
				`${attrition.elapsedMs}ms of retry budget — ${body}`,
		);
		this.name = "CfRateLimitError";
		this.method = method;
		this.path = path;
		this.attempts = attrition.attempts;
		this.elapsedMs = attrition.elapsedMs;
		this.body = body;
	}
}

export const isCfRateLimit = (e: unknown): e is CfRateLimitError => e instanceof CfRateLimitError;

export interface RateLimitRetryOptions {
	/** Wall-clock retry budget in ms (default {@link D1_REST_BUDGET_MS}); 0 disables retrying. */
	budgetMs?: number;
	/** Runaway cap on retries AFTER the first attempt (default {@link D1_REST_MAX_RETRIES}). */
	maxRetries?: number;
	/** Base of the exponential backoff, in ms (default 500). */
	baseDelayMs?: number;
	/** Ceiling on one backoff wait, in ms (default 8000). */
	maxDelayMs?: number;
	/** Names the round-trip in the give-up log line and any raised error. */
	label?: string;
	/**
	 * Called exactly when the budget is spent and the answer is STILL 429. Defaults to a
	 * `console.warn` naming the call — so every call site is self-identifying without opting in,
	 * including one added later that forgets to pass a handler.
	 */
	onGiveUp?: (attrition: RateLimitAttrition) => void;
	/** Injected for tests — real sleep by default. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected for tests — `Math.random` by default. */
	random?: () => number;
	/** Injected for tests — `Date.now` by default. */
	now?: () => number;
}

const warnGiveUp = ({label, attempts, elapsedMs}: RateLimitAttrition): void => {
	console.warn(
		`[integration] CF rate-limit (HTTP 429, code 971) not cleared: ${label} — ` +
			`${attempts} attempt${attempts === 1 ? "" : "s"} over ${elapsedMs}ms of retry budget (#3548)`,
	);
};

/**
 * `Retry-After` in ms, or `undefined` when absent/unparseable. Both RFC 9110 forms are accepted
 * (delta-seconds and HTTP-date). Observed reality on this path: CF sent NO usable value on the
 * ejecting run (`retryAfter: Millis 0`), so honoring it is a correctness upgrade for when CF does
 * send one, not the mechanism that fixes #3548 — the deadline is.
 */
const retryAfterMs = (res: Response, nowMs: number): number | undefined => {
	const raw = res.headers.get("retry-after");
	if (raw === null) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
};

/**
 * Re-send `send()` while it answers HTTP 429, until the wall-clock budget is spent. Returns the
 * first non-429 `Response` (a success OR a real error the caller classifies), or the final 429 if
 * the budget ran out — it never swallows a real failure and never throws of its own accord.
 */
export const cfFetchWithRateLimitRetry = async (
	send: () => Promise<Response>,
	{
		budgetMs = D1_REST_BUDGET_MS,
		maxRetries = D1_REST_MAX_RETRIES,
		baseDelayMs = D1_REST_BASE_DELAY_MS,
		maxDelayMs = D1_REST_MAX_DELAY_MS,
		label = "CF REST call",
		onGiveUp = warnGiveUp,
		sleep = defaultSleep,
		random = Math.random,
		now = Date.now,
	}: RateLimitRetryOptions = {},
): Promise<Response> => {
	const startedAt = now();
	let attempts = 1;
	let res = await send();
	for (let attempt = 0; res.status === CF_RATE_LIMIT_STATUS; attempt++) {
		const remaining = budgetMs - (now() - startedAt);
		if (remaining <= 0 || attempt >= maxRetries) break;
		// Full-jitter backoff: the parallel stages that tripped the shared rate limit must not
		// re-sync into a thundering herd on a fixed delay, so spread each retry uniformly over
		// [0, ceil). A CF-supplied `Retry-After` is a floor on that — never wait less than the
		// origin asked. Both are clamped to what's left of the budget so the deadline is hard.
		const ceil = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
		const wait = Math.max(Math.floor(random() * ceil), retryAfterMs(res, now()) ?? 0);
		await res.body?.cancel().catch(() => {}); // release the discarded 429 body before re-sending
		await sleep(Math.min(wait, remaining));
		res = await send();
		attempts++;
	}
	if (res.status === CF_RATE_LIMIT_STATUS) {
		onGiveUp({label, attempts, elapsedMs: now() - startedAt});
	}
	return res;
};

/**
 * A `fetch` that funnels every send through {@link cfFetchWithRateLimitRetry}, so a test's
 * DATA-PLANE D1 REST calls carry the same 429 discipline the setup path has. Inject it as the
 * `FetchHttpClient.Fetch` reference the rest layer reads.
 *
 * Why this seam and not a per-call catch: `fetch` RESOLVES a 429 as a `Response` (an HTTP status
 * is not a network error, so it never rejects), so the retry inspects `.status` and re-sends
 * BEFORE `queryDatabase` maps a settled 429 body to a thrown `TooManyRequests`. One seam covers
 * every data-plane call, the polled and the direct reads alike (#3099).
 */
export const rateLimitRetryingFetch = (
	base: typeof globalThis.fetch,
	options: RateLimitRetryOptions = {},
): typeof globalThis.fetch =>
	((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
		cfFetchWithRateLimitRetry(() => base(input, init), {
			label: fetchLabel(input, init),
			...options,
		})) as typeof globalThis.fetch;

/** `<METHOD> <url>` for a `fetch` call, across all three `input` shapes, for the give-up line. */
const fetchLabel = (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1],
): string => {
	const isRequest = typeof input === "object" && input !== null && "url" in input;
	const url = isRequest ? (input as Request).url : String(input);
	const method = init?.method ?? (isRequest ? (input as Request).method : "GET");
	return `${method.toUpperCase()} ${url}`;
};
