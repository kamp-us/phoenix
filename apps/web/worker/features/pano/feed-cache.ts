/**
 * The base-feed edge-cache purger (ADR 0170, #2324): after a feed-visible pano write,
 * purge the edge entry the base-feed GET populated, tagged `pano-feed`.
 *
 * The cache-side twin of `WorkerLivePublisher` — same fanned-mutation seam (ADR 0155),
 * same fire-and-forget `waitUntil`, same `never` error channel so a failed purge can
 * never fail the committed mutation. A lost purge self-heals within the TTL backstop.
 *
 * The purge is the worker's OWN capability (`ctx.cache.purge`), scoped to this worker:
 * no zone-level purge and no standing API token.
 */
import {Context} from "effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PANO_FEED_CACHE_TAG = "pano-feed";

/**
 * The edge TTL backstop (seconds): bounds staleness when a purge is lost, so the feed
 * self-heals on its own (ADR 0170, AC#3).
 */
export const BASE_FEED_CACHE_TTL_SECONDS = 30;

/**
 * `s-maxage` targets the shared per-Worker edge cache without pinning the doc in the
 * browser, since the client reconciles the live overlay anyway.
 */
export const baseFeedCacheControl = `public, s-maxage=${BASE_FEED_CACHE_TTL_SECONDS}`;

/**
 * A purge failed inside the swallow wrapper. Never reaches the mutation: the purge
 * runs after the DB write and must not fail a committed mutation (ADR 0039).
 */
export class FeedCachePurgeError extends Schema.TaggedErrorClass<FeedCachePurgeError>()(
	"pano/FeedCachePurgeError",
	{cause: Schema.Defect()},
) {}

export interface WorkerPanoFeedCache {
	readonly purge: () => Effect.Effect<void>;
}

export interface PanoFeedCacheOptions {
	/** In production `ctx.cache.purge`; in tests a recording/failing/slow stub. */
	readonly purge: (options: {tags: string[]}) => Promise<unknown>;
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

export function panoFeedCacheFor(options: PanoFeedCacheOptions): WorkerPanoFeedCache {
	// One purge = one detached promise; the terminal `.catch` is the async half of the
	// swallow-with-log contract.
	const schedule = (): void => {
		options.waitUntil(
			Promise.resolve(options.purge({tags: [PANO_FEED_CACHE_TAG]})).catch((error: unknown) => {
				console.error(`pano feed cache purge tag:${PANO_FEED_CACHE_TAG} failed`, error);
			}),
		);
	};

	return {
		// Sync half of the swallow-with-log contract: `ignore` collapses any failure (e.g. a
		// gone execution context) to the `Effect<void>` the contract promises (ADR 0039).
		purge: () =>
			Effect.try({try: schedule, catch: (cause) => new FeedCachePurgeError({cause})}).pipe(
				Effect.ignore({log: "Warn"}),
			),
	};
}

/**
 * The per-request purger service, built in `route.ts` off the execution context and
 * registered on `PhoenixFateLive`'s per-request list like `CurrentActor`.
 */
export class PanoFeedCache extends Context.Service<PanoFeedCache, WorkerPanoFeedCache>()(
	"pano/PanoFeedCache",
) {}
