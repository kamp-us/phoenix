/**
 * Bounded retry for the setup-only D1 REST path against a transient CF rate-limit (HTTP 429).
 *
 * The per-file-stage integration model (ADR 0082) hammers ONE Cloudflare account's D1
 * control-plane REST (`/d1/database/<id>/query`) from ~24 parallel stages. On a `merge_group`
 * batch the combined load trips the account rate limit — HTTP 429, error code 971
 * "TooManyRequests" — and a setup-only `execD1`/`setLastActivityAt` (`_harness.ts`) then throws,
 * reddening `integration` on the batched ref and evicting clean bystander PRs (#2915). A 429 is
 * the CF gateway REJECTING the request before it executes — no partial write — so replay is safe
 * by construction; the same class is already treated transient-retryable at the DEPLOY layer
 * (`_deploy-transient.ts`, `TooManyRequests`). This is the data-plane-setup counterpart.
 *
 * Scoped to 429 ONLY: a real SQL error surfaces as a 200-with-`errors[]` (classified by
 * `runD1Query`), and a genuine API error as a non-429 4xx/5xx — neither is a 429, so neither is
 * retried and a real failure still surfaces at once. A pure leaf (injectable `send`/`sleep`/
 * `random`, no `fetch`/creds dependency) so the retry logic is unit-testable offline.
 */

export const CF_RATE_LIMIT_STATUS = 429;
export const D1_REST_MAX_RETRIES = 5;
export const D1_REST_BASE_DELAY_MS = 500;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RateLimitRetryOptions {
	/** Max retries AFTER the first attempt (default 5 → up to 6 sends). */
	maxRetries?: number;
	/** Base of the exponential backoff, in ms (default 500). */
	baseDelayMs?: number;
	/** Injected for tests — real sleep by default. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected for tests — `Math.random` by default. */
	random?: () => number;
}

/**
 * Re-send `send()` while it answers HTTP 429, with **full-jitter** exponential backoff, up to
 * `maxRetries` extra attempts. Returns the first non-429 `Response` (a success OR a real error
 * the caller classifies), or the final 429 `Response` if the budget is exhausted — it never
 * swallows a real failure and never throws of its own accord.
 */
export const cfFetchWithRateLimitRetry = async (
	send: () => Promise<Response>,
	{
		maxRetries = D1_REST_MAX_RETRIES,
		baseDelayMs = D1_REST_BASE_DELAY_MS,
		sleep = defaultSleep,
		random = Math.random,
	}: RateLimitRetryOptions = {},
): Promise<Response> => {
	let res = await send();
	for (let attempt = 0; attempt < maxRetries && res.status === CF_RATE_LIMIT_STATUS; attempt++) {
		// Full-jitter backoff: the ~24 parallel stages that tripped the shared rate limit must
		// not re-sync into a thundering herd on a fixed delay, so spread each retry uniformly
		// over [0, base·2^attempt). Release the discarded 429 body before re-sending.
		await res.body?.cancel().catch(() => {});
		const ceil = baseDelayMs * 2 ** attempt;
		await sleep(Math.floor(random() * ceil));
		res = await send();
	}
	return res;
};

/**
 * A `fetch` that funnels every send through {@link cfFetchWithRateLimitRetry}, so the SAME 429
 * discipline the setup path has (#2915/#3089) also covers a test's DATA-PLANE D1 REST calls issued
 * over `makeD1Rest`'s `restLayer`. Inject it as the `FetchHttpClient.Fetch` reference the rest layer
 * reads (`Layer.succeed(FetchHttpClient.Fetch, rateLimitRetryingFetch(fetch))`).
 *
 * Why this seam and not a per-call catch: `fetch` RESOLVES a 429 as a `Response` (an HTTP status is
 * not a network error, so it never rejects), so the retry inspects `.status` and re-sends BEFORE
 * `queryDatabase` maps a settled 429 body to a thrown error. A 429 therefore never surfaces as a
 * thrown error to drizzle or to `readYourWrite`'s poll — one seam covers every data-plane call
 * (`has`/`mint`/`remove`), the polled and the direct reads alike, reusing #3089's wrapper unchanged
 * rather than growing a second retry path (#3099).
 */
export const rateLimitRetryingFetch = (
	base: typeof globalThis.fetch,
	options: RateLimitRetryOptions = {},
): typeof globalThis.fetch =>
	((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
		cfFetchWithRateLimitRetry(() => base(input, init), options)) as typeof globalThis.fetch;
