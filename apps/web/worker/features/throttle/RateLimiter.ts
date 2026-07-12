/**
 * `RateLimiter` — the per-actor mutation-volume throttle (ADR 0177). It owns the
 * token-bucket algorithm ({@link TokenBucket}) and the actor→budget-key mapping;
 * the state's home and RMW atomicity are the {@link RateLimitStore} port's job
 * (the DO-vs-in-isolate swap point). Wired once at the fate composition root
 * (`fate/layers.ts`) over the merged mutations record, so it bounds every
 * feature's mutation path without touching a single feature.
 */
import {type Actor, matchActor} from "@kampus/authz";
import {Clock, Context, Effect, Layer, Option} from "effect";
import {RateLimitExceeded} from "./errors.ts";
import {RateLimitStore} from "./RateLimitStore.ts";
import {type TokenBucketPolicy, tokenBucketPolicy, tryConsume} from "./TokenBucket.ts";

/**
 * The per-actor mutation budget: one default class covers every mutation — 60
 * tokens of burst refilling 1/s (≈60 writes/minute sustained). Chosen well clear
 * of a human's real write cadence (a fast reader voting/reacting rarely nears
 * one write/second sustained) yet tight enough to bound a scripted flood — the
 * abuse the audit named (sandbox floods, report spam, reaction churn). ADR 0177
 * records why a single aggregate bucket (not per-mutation-class sub-buckets) is
 * the v1 shape and where per-class values would slot in.
 */
export const DEFAULT_MUTATION_POLICY: TokenBucketPolicy = tokenBucketPolicy(60, 1);

export interface RateLimiterAccess {
	/**
	 * Spend one token of the actor's mutation budget; fail with
	 * {@link RateLimitExceeded} when the bucket is empty. Anonymous actors carry
	 * no budget key — their writes are refused by each mutation's own auth gate —
	 * so they pass through untouched.
	 */
	readonly check: (actor: Actor) => Effect.Effect<void, RateLimitExceeded>;
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterAccess>()(
	"@kampus/throttle/RateLimiter",
) {}

/** The per-actor budget key; `None` for anonymous traffic (not throttled here). */
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
