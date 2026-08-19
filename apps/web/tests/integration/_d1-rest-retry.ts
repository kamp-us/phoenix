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
 * budget is therefore a DEADLINE (`budgetMs`): keep re-sending while budget remains, with the
 * attempt cap demoted to a runaway guard. Full jitter is retained per-wait (it is what de-syncs
 * the parallel stages), it just no longer decides when to give up.
 *
 * **The deadline measures time CLOUDFLARE kept us waiting, not wall clock (#3548 round 2).** The
 * `merge_group` ejection of PR #4033 gave up "2 attempts over 45136ms of retry budget" (four such
 * give-ups, all 2 attempts, 45046–45195ms) — and 2 attempts is the tell. One backoff sleep at
 * attempt 0 is capped at `baseDelayMs` (500ms) PROVIDED CF sent no `Retry-After`, which is a floor
 * on the wait and is not bounded by that ceiling. CF sent none on this path (`retryAfter: Millis 0`,
 * run `29665891972`); on that premise ~44.6s of the 45s was spent INSIDE the two sends, i.e. queued
 * in the harness's own throttle, not being rate-limited by Cloudflare. The premise is load-bearing
 * and the give-up line did not record it for the ejecting run: a large `Retry-After` also yields
 * 2 attempts over ~45s, so the elapsed numbers alone do not separate the two. Both sinks are fixed,
 * and the attrition breakdown below now records `retryAfterMs` so the next occurrence is read off
 * the log line instead of re-derived. A wall-clock deadline charged the harness's self-imposed
 * pacing to the budget it meant to spend asking CF, and the loop expired having asked twice. So
 * `send` is handed a `queued` sink, the throttle reports what it made the call wait, and that time
 * is deducted: `budgetMs` now means "up to this much time with CF actually answering 429". Raising
 * the number would not have fixed this — the budget was never spent.
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
 * Retry budget per logical CF REST call, counted over time CF spent answering 429 (harness
 * throttle queueing is deducted). Sized above the ~8s the old attempt-count budget averaged.
 * Because queueing is no longer charged here, this number alone no longer bounds the call in wall
 * clock — {@link D1_REST_WALL_CLOCK_CEILING_MS} is what keeps it under `vitest.config.ts`'s 120s
 * `testTimeout`, i.e. what stops a named 429 becoming the opaque "Hook timed out" shape (the
 * failure mode `_request-stall.ts` documents). Deliberately NOT raised for #4033's ejection: that
 * run spent 1.2% of this budget on Cloudflare, so the number was never the binding constraint, and
 * no sane CI budget outlasts a ~290s account-wide plateau anyway.
 */
export const D1_REST_BUDGET_MS = 45_000;
/**
 * Hard wall-clock ceiling on ONE logical call, held alongside the CF-facing budget above.
 *
 * Deducting `queuedMs` bought CF its full budget back, but it also removed the wall-clock bound the
 * sizing rationale leaned on: with queueing uncharged, the loop's only remaining wall-clock limit
 * was `maxRetries` times however long the throttle queued each attempt — 24 attempts at even 5s of
 * queueing is 120s, exactly the opaque "Hook timed out" the named 429 exists to replace. So the two
 * bounds are kept as belt and braces: CF gets {@link D1_REST_BUDGET_MS} of genuine asking, and the
 * call still cannot outlive `vitest.config.ts`'s 120s `testTimeout`. {@link GiveUpReason} names
 * which one fired, so a give-up is never ambiguous about the bound that ended it.
 *
 * The guarantee is per logical call, not per test: a test making several protected CF calls during
 * a sustained plateau can still exceed `testTimeout`. That limit predates this ceiling and is
 * stated in `.patterns/alchemy-test-harness.md` rather than claimed away here.
 */
export const D1_REST_WALL_CLOCK_CEILING_MS = 90_000;
/** Runaway guard only — the deadline above is what normally ends the loop. */
export const D1_REST_MAX_RETRIES = 24;
export const D1_REST_BASE_DELAY_MS = 500;
/** Ceiling on a single backoff wait, so one long wait can't swallow the whole budget. */
export const D1_REST_MAX_DELAY_MS = 8_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Why the retry loop stopped — the variants say where the budget went (#3548). */
export type GiveUpReason =
	/** The CF-facing deadline ran out — CF really did stay 429 for the whole budget. */
	| "budget-exhausted"
	/** CF asked for a `Retry-After` longer than the budget left; waiting it out is CI time burnt for nothing. */
	| "retry-after-exceeds-budget"
	/** The runaway guard tripped — many cheap attempts, budget still unspent. */
	| "max-retries"
	/** Wall clock ran out while the CF-facing budget was still unspent — i.e. we were queueing, not rate-limited. */
	| "wall-clock-ceiling";

export interface RateLimitAttrition {
	/** Caller-supplied name of the round-trip (method + path), for the log line. */
	readonly label: string;
	/** Total sends, including the first attempt. */
	readonly attempts: number;
	/** Wall-clock ms from the first send to giving up. */
	readonly elapsedMs: number;
	/** Of {@link elapsedMs}, ms spent queued in the harness's OWN throttle — not charged to the budget. */
	readonly queuedMs: number;
	/** Of {@link elapsedMs}, ms slept in 429 backoff. */
	readonly backoffMs: number;
	/** The CF-facing budget this call was allowed, for reading `elapsedMs - queuedMs` against. */
	readonly budgetMs: number;
	readonly reason: GiveUpReason;
	/** The last usable `Retry-After` CF sent, in ms; absent when CF sent none (as on the D1 path). */
	readonly retryAfterMs?: number | undefined;
}

export const budgetSpentMs = (a: RateLimitAttrition): number => a.elapsedMs - a.queuedMs;

const attritionSummary = (a: RateLimitAttrition): string =>
	`${a.attempts} attempt${a.attempts === 1 ? "" : "s"} (${a.reason}) — ` +
	`${budgetSpentMs(a)}ms of the ${a.budgetMs}ms CF-facing retry budget spent over ${a.elapsedMs}ms ` +
	`wall clock (${a.queuedMs}ms queued in the harness's own throttle, ${a.backoffMs}ms in backoff)` +
	(a.retryAfterMs === undefined ? "" : `; CF last asked for Retry-After ${a.retryAfterMs}ms`);

/** Thrown in place of a bare "failed: 429 <body>" so the round-trip names itself (#3548). */
export class CfRateLimitError extends Error {
	readonly _tag = "CfRateLimit";
	readonly method: string;
	readonly path: string;
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly body: string;
	readonly attrition: RateLimitAttrition;
	constructor(method: string, path: string, attrition: RateLimitAttrition, body: string) {
		super(
			`Cloudflare API ${method} ${path} rate-limited (HTTP 429, code 971): gave up after ` +
				`${attritionSummary(attrition)} — ${body}`,
		);
		this.name = "CfRateLimitError";
		this.method = method;
		this.path = path;
		this.attempts = attrition.attempts;
		this.elapsedMs = attrition.elapsedMs;
		this.attrition = attrition;
		this.body = body;
	}
}

export const isCfRateLimit = (e: unknown): e is CfRateLimitError => e instanceof CfRateLimitError;

export interface RateLimitRetryOptions {
	/** CF-facing retry budget in ms (default {@link D1_REST_BUDGET_MS}); 0 disables retrying. */
	budgetMs?: number;
	/** Hard wall-clock ceiling on the whole call, ms (default {@link D1_REST_WALL_CLOCK_CEILING_MS}). */
	wallClockCeilingMs?: number;
	/** Runaway cap on retries AFTER the first attempt (default {@link D1_REST_MAX_RETRIES}). */
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Names the round-trip in the give-up log line and any raised error. */
	label?: string;
	/**
	 * Called exactly when the budget is spent and the answer is STILL 429. Defaults to a
	 * `console.warn` naming the call — so every call site is self-identifying without opting in,
	 * including one added later that forgets to pass a handler.
	 */
	onGiveUp?: (attrition: RateLimitAttrition) => void;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

const warnGiveUp = (attrition: RateLimitAttrition): void => {
	console.warn(
		`[integration] CF rate-limit (HTTP 429, code 971) not cleared: ${attrition.label} — ` +
			`${attritionSummary(attrition)} (#3548)`,
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
 * One attempt at the round-trip. `queued` is the sink through which a transport reports ms it made
 * this attempt wait before reaching Cloudflare (throttle pacing + slot contention); that time is
 * deducted from the budget, because it is the harness rate-limiting itself, not CF doing it.
 */
export type CfSend = (queued: (ms: number) => void) => Promise<Response>;

/**
 * Re-send `send()` while it answers HTTP 429, until the CF-facing budget is spent. Returns the
 * first non-429 `Response` (a success OR a real error the caller classifies), or the final 429 if
 * the budget ran out — it never swallows a real failure and never throws of its own accord.
 */
export const cfFetchWithRateLimitRetry = async (
	send: CfSend,
	{
		budgetMs = D1_REST_BUDGET_MS,
		wallClockCeilingMs = D1_REST_WALL_CLOCK_CEILING_MS,
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
	let queuedMs = 0;
	let backoffMs = 0;
	let asked: number | undefined;
	let reason: GiveUpReason = "budget-exhausted";
	const queued = (ms: number): void => {
		queuedMs += ms;
	};
	let attempts = 1;
	let res = await send(queued);
	for (let attempt = 0; res.status === CF_RATE_LIMIT_STATUS; attempt++) {
		// Harness-imposed queueing is deducted: the budget bounds how long CF is allowed to keep
		// answering 429, not how long our own throttle made the call wait for a slot (#3548).
		const elapsed = now() - startedAt;
		const remaining = budgetMs - (elapsed - queuedMs);
		if (remaining <= 0) break;
		// The other half of that deduction: with queueing uncharged, only this bounds the call in
		// wall clock (see {@link D1_REST_WALL_CLOCK_CEILING_MS}). Checked after the CF-facing budget
		// so a genuine 429 exhaustion keeps reporting `budget-exhausted`.
		const wallRemaining = wallClockCeilingMs - elapsed;
		if (wallRemaining <= 0) {
			reason = "wall-clock-ceiling";
			break;
		}
		if (attempt >= maxRetries) {
			reason = "max-retries";
			break;
		}
		const askedNow = retryAfterMs(res, now());
		if (askedNow !== undefined) asked = askedNow;
		// CF asking for longer than the budget left is a decided answer, not something to wait out:
		// sleeping the remainder to buy one doomed final attempt spends CI time for near-zero odds.
		// Give up now, with `retry-after-exceeds-budget` naming why the run went red fast.
		if (askedNow !== undefined && askedNow > remaining) {
			reason = "retry-after-exceeds-budget";
			break;
		}
		// Full-jitter backoff: the parallel stages that tripped the shared rate limit must not
		// re-sync into a thundering herd on a fixed delay, so spread each retry uniformly over
		// [0, ceil). A CF-supplied `Retry-After` is a floor on that — never wait less than the
		// origin asked. Both are clamped to what's left of EITHER bound, so each deadline is hard
		// with overshoot bounded by one in-flight send.
		const ceil = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
		const wait = Math.min(
			Math.max(Math.floor(random() * ceil), askedNow ?? 0),
			remaining,
			wallRemaining,
		);
		await res.body?.cancel().catch(() => {});
		await sleep(wait);
		backoffMs += wait;
		res = await send(queued);
		attempts++;
	}
	if (res.status === CF_RATE_LIMIT_STATUS) {
		onGiveUp({
			label,
			attempts,
			elapsedMs: now() - startedAt,
			queuedMs,
			backoffMs,
			budgetMs,
			reason,
			retryAfterMs: asked,
		});
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
export type QueueReportingFetch = (
	input: Parameters<typeof globalThis.fetch>[0],
	init: Parameters<typeof globalThis.fetch>[1],
	/** See {@link CfSend} — a throttled base reports its queueing here so the budget can deduct it. */
	queued: (ms: number) => void,
) => Promise<Response>;

export const rateLimitRetryingFetch = (
	base: QueueReportingFetch,
	options: RateLimitRetryOptions = {},
): typeof globalThis.fetch =>
	((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
		cfFetchWithRateLimitRetry((queued) => base(input, init, queued), {
			label: fetchLabel(input, init),
			...options,
		})) as typeof globalThis.fetch;

const fetchLabel = (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1],
): string => {
	const isRequest = typeof input === "object" && input !== null && "url" in input;
	const url = isRequest ? (input as Request).url : String(input);
	const method = init?.method ?? (isRequest ? (input as Request).method : "GET");
	return `${method.toUpperCase()} ${url}`;
};
