/**
 * `RateLimiter` — the per-actor mutation-volume throttle (ADR 0177). It owns the
 * token-bucket algorithm and the actor→budget-key mapping; the state's home and RMW
 * atomicity belong to the {@link RateLimitStore} port. Wired once at the fate
 * composition root over the merged mutations record, so it bounds every feature's
 * mutation path without touching a single feature.
 */
import {type Actor, matchActor} from "@kampus/authz";
import {Clock, Context, Effect, Layer, Option} from "effect";
import {RateLimitExceeded} from "./errors.ts";
import {RateLimitStore} from "./RateLimitStore.ts";
import {type TokenBucketPolicy, tokenBucketPolicy, tryConsume} from "./TokenBucket.ts";

/**
 * One aggregate bucket covers every mutation — 60 tokens of burst refilling 1/s.
 * ADR 0177 records why that beats per-mutation-class sub-buckets for v1.
 */
export const DEFAULT_MUTATION_POLICY: TokenBucketPolicy = tokenBucketPolicy(60, 1);

export interface RateLimiterAccess {
	/**
	 * Anonymous actors carry no budget key and pass through untouched — their writes
	 * are refused by each mutation's own auth gate.
	 */
	readonly check: (actor: Actor) => Effect.Effect<void, RateLimitExceeded>;
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterAccess>()(
	"@kampus/throttle/RateLimiter",
) {}

const actorKey = (actor: Actor): Option.Option<string> =>
	matchActor(actor, {
		onUnauthenticated: () => Option.none(),
		onHuman: (h) => Option.some(`human:${h.id}`),
		onAgent: (a) => Option.some(`agent:${a.id}`),
	});

export const RateLimiterLive = Layer.effect(RateLimiter)(
	Effect.gen(function* () {
		const store = yield* RateLimitStore;
		const policy = DEFAULT_MUTATION_POLICY;
		return {
			check: Effect.fn("RateLimiter.check")(function* (actor: Actor) {
				const key = actorKey(actor);
				if (Option.isNone(key)) return;
				const nowMs = yield* Clock.currentTimeMillis;
				const outcome = yield* store.transition(key.value, (state) => {
					const result = tryConsume(state, policy, nowMs);
					return [result.state, result] as const;
				});
				if (!outcome.allowed) {
					return yield* new RateLimitExceeded({
						message: "çok hızlısın, biraz yavaşla",
						retryAfterMs: outcome.retryAfterMs,
					});
				}
			}),
		};
	}),
);
