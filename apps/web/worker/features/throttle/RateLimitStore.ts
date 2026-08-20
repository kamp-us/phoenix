/**
 * The backing-store port for the token bucket (ADR 0177). `RateLimiter` owns the
 * algorithm; the store owns only where the state lives and how the read-modify-write
 * is made atomic. That split is the swap point: a per-actor Durable Object drops in
 * behind this same port without touching `RateLimiter`.
 */
import {Context, Effect, Layer} from "effect";
import type {TokenBucketState} from "./TokenBucket.ts";

export interface RateLimitStoreAccess {
	// Per-key atomicity of this read-apply-write IS the store's whole contract: an
	// interleaved cycle would let two concurrent mutations both spend the last token.
	readonly transition: <R>(
		key: string,
		transition: (state: TokenBucketState | undefined) => readonly [TokenBucketState, R],
	) => Effect.Effect<R>;
}

export class RateLimitStore extends Context.Service<RateLimitStore, RateLimitStoreAccess>()(
	"@kampus/throttle/RateLimitStore",
) {}

// JS's single-threaded event loop makes the synchronous read-apply-write atomic per key
// with no lock. The bound is per-isolate, not global — ADR 0177 records that as the
// trigger for moving to a Durable Object.
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
