/**
 * `RateLimitStore` — the dependency-inverted backing-store port for the token
 * bucket (ADR 0177). The `RateLimiter` service owns the algorithm (the pure
 * `TokenBucket`); the store owns only *where the state lives and how the
 * read-modify-write is made atomic*. That split is the storage swap point: the
 * in-isolate `Map` ships today; a per-actor Durable Object (ADR 0037) drops in
 * behind this same port at the composition root when registration opens, without
 * touching `RateLimiter` — the same inversion idiom as Vote's `KarmaBump` /
 * `VoterStanding` (`.patterns/feature-services.md`).
 */
import {Context, Effect, Layer} from "effect";
import type {TokenBucketState} from "./TokenBucket.ts";

export interface RateLimitStoreAccess {
	/**
	 * Atomically read the bucket state for `key`, apply the pure `transition`,
	 * persist the returned state, and yield the transition's result. The per-key
	 * atomicity of this read-apply-write IS the store's whole contract — an
	 * interleaved RMW would let two concurrent mutations both spend the last
	 * token. Each backing guarantees it at its own seam: the isolate's single
	 * event loop below, a Durable Object's single-threaded execution later.
	 */
	readonly transition: <R>(
		key: string,
		transition: (state: TokenBucketState | undefined) => readonly [TokenBucketState, R],
	) => Effect.Effect<R>;
}

export class RateLimitStore extends Context.Service<RateLimitStore, RateLimitStoreAccess>()(
	"@kampus/throttle/RateLimitStore",
) {}

/**
 * The in-isolate backing: a per-isolate `Map` built once per isolate (via the
 * fate runtime's memoMap). JS's single-threaded event loop makes the synchronous
 * read-apply-write atomic per key with no lock. Its bound is per-isolate, not
 * global — ADR 0177 records that as the v1→Durable-Object upgrade trigger.
 */
export const InIsolateRateLimitStoreLive = Layer.sync(RateLimitStore)(() => {
	const buckets = new Map<string, TokenBucketState>();
	return {
		transition: (key, transition) =>
			Effect.sync(() => {
				const [next, result] = transition(buckets.get(key));
				buckets.set(key, next);
				return result;
			}),
	};
});
