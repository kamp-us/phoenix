/**
 * The base-feed edge-cache purger — leg B of the "instant reload" epic (#2316,
 * child #2324, ADR 0170). Its one job: after a feed-visible pano write, purge the
 * per-Worker edge cache entry the base-feed GET populated, tagged `pano-feed`.
 *
 * It is the cache-side twin of `WorkerLivePublisher`: the SAME fanned-mutation seam
 * (ADR 0155) that publishes the `/fate/live` invalidation also fires this purge, so
 * one write drives two invalidations. Both are best-effort and fire-and-forget via
 * `waitUntil` (CF's only post-response work extension — no shutdown hook, ADR
 * 0028/0039), and both have a `never` error channel so a failed purge can never fail
 * the committed mutation — the swallow-with-log contract lives here, once, exactly as
 * `live-publisher.ts` holds it for the live fan-out.
 *
 * Two containment properties:
 *   - `enabled` is the leg-B cache flag (`pano-feed-edge-cache`, default-off). Off ⇒
 *     `purge()` is a pure no-op that schedules nothing (AC#5: flag off ⇒ no purge
 *     calls). The base-feed route emits no `Cache-Control` under the same flag, so an
 *     off deploy neither caches nor purges.
 *   - The purge is the worker's OWN runtime capability (`ctx.cache.purge`, injected as
 *     `purge` here), scoped to this worker — no zone-level purge, no standing API token
 *     (ADR 0170 honors the prod-cred-free invariant).
 *
 * A lost purge self-heals within the base feed's TTL backstop (`baseFeedCacheControl`),
 * so correctness never depends on a purge landing.
 */
import {Context} from "effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The `Cache-Tag` the base-feed GET stamps and this purger targets. */
export const PANO_FEED_CACHE_TAG = "pano-feed";

/**
 * The base-feed edge TTL backstop (seconds). Bounds staleness when a purge is lost:
 * the cached entry expires on its own within this window, so the feed self-heals
 * (ADR 0170, AC#3). Kept short — the live overlay (`POST /fate`) already reconciles
 * the per-viewer scalars, so the cached base only needs to be roughly fresh.
 */
export const BASE_FEED_CACHE_TTL_SECONDS = 30;

/**
 * The `Cache-Control` the base-feed GET response carries when the leg-B cache flag is
 * on. `s-maxage` targets the shared per-Worker edge cache (the TTL backstop) without
 * pinning the doc in the browser, since the client reconciles the live overlay anyway.
 */
export const baseFeedCacheControl = `public, s-maxage=${BASE_FEED_CACHE_TTL_SECONDS}`;

/**
 * A purge failed inside the swallow wrapper. Never reaches the mutation: the purger
 * maps it away (logged at `Warn`) in its `never` error channel, since the purge runs
 * after the DB write and must not fail the committed mutation (ADR 0039) — the exact
 * contract `LivePublishError` holds for the live fan-out.
 */
export class FeedCachePurgeError extends Schema.TaggedErrorClass<FeedCachePurgeError>()(
	"pano/FeedCachePurgeError",
	{cause: Schema.Defect()},
) {}

/** The per-request purger the fanned pano seam fires alongside its live publish. */
export interface WorkerPanoFeedCache {
	/** Purge the base-feed edge entry (tag `pano-feed`). `Effect<void>` by contract. */
	readonly purge: () => Effect.Effect<void>;
}

/** The two per-request capabilities the purger closes over, plus the flag gate. */
export interface PanoFeedCacheOptions {
	/** The leg-B cache flag state (`pano-feed-edge-cache`). Off ⇒ `purge()` no-ops. */
	readonly enabled: boolean;
	/**
	 * Deliver one tag purge — in production `ctx.cache.purge` (the worker's own cache
	 * capability), in tests a recording/failing/slow stub. A rejection is caught on the
	 * detached promise below.
	 */
	readonly purge: (options: {tags: string[]}) => Promise<unknown>;
	/** The request's `ExecutionContext.waitUntil`. */
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Build the per-request base-feed purger. */
export function panoFeedCacheFor(options: PanoFeedCacheOptions): WorkerPanoFeedCache {
	// Flag-off is a pure no-op: schedule nothing, touch no capability (AC#5).
	if (!options.enabled) {
		return {purge: () => Effect.void};
	}

	// One purge = one detached promise; the terminal `.catch` is the async half of the
	// swallow-with-log contract, mirroring `livePublisherFor`'s `schedule`.
	const schedule = (): void => {
		options.waitUntil(
			Promise.resolve(options.purge({tags: [PANO_FEED_CACHE_TAG]})).catch((error: unknown) => {
				console.error(`pano feed cache purge tag:${PANO_FEED_CACHE_TAG} failed`, error);
			}),
		);
	};

	return {
		// Sync half of the swallow-with-log contract: the `waitUntil` schedule runs inside
		// `Effect.try`, and `ignore` collapses any failure (e.g. a gone execution context)
		// to the `Effect<void>` the contract promises (ADR 0039, once here).
		purge: () =>
			Effect.try({try: schedule, catch: (cause) => new FeedCachePurgeError({cause})}).pipe(
				Effect.ignore({log: "Warn"}),
			),
	};
}

/**
 * The per-request purger service, provided per request from `route.ts` (built off the
 * execution context + the leg-B flag) exactly as `CurrentActor` / `RequestFlagOverrides`
 * are, and registered on `PhoenixFateLive`'s per-request list. A fanned pano mutation
 * resolves it (`yield* PanoFeedCache`) and hands it to `panoLive` so the publish seam
 * fires the purge alongside the live invalidation.
 */
export class PanoFeedCache extends Context.Service<PanoFeedCache, WorkerPanoFeedCache>()(
	"pano/PanoFeedCache",
) {}
