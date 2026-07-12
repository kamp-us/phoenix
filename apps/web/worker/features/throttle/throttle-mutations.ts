/**
 * `throttleMutations` — wrap every mutation's `resolve` with the per-actor
 * throttle (ADR 0177), applied ONCE at the fate composition root
 * (`fate/layers.ts`) over the merged mutations record so it reaches every
 * feature's mutation path without touching a single feature. The token is spent
 * BEFORE the handler runs, so a denial fails the mutation with
 * `RATE_LIMIT_EXCEEDED` and the handler — its write AND its `/fate/live` publish
 * — never runs; a throttled mutation is transparent to the fanout invariant
 * because it simply doesn't execute.
 */
import {CurrentActor} from "@kampus/authz";
import type {AnyFateMutation, FateMutationsRecord} from "@kampus/fate-effect";
import {Effect} from "effect";
import {RateLimiter} from "./RateLimiter.ts";

/**
 * The wrapped `resolve` gains `RateLimiter` + `CurrentActor` in its true
 * requirements; the return type is preserved as the input record `M` because
 * both are provided at run time — `RateLimiter` from the worker layer,
 * `CurrentActor` per request off the session (ADR 0107 §7) — the same re-pin the
 * fate provision pipeline applies to every erased entry effect.
 */
export const throttleMutations = <M extends FateMutationsRecord>(mutations: M): M => {
	const throttled: Record<string, AnyFateMutation> = {};
	for (const [name, entry] of Object.entries(mutations)) {
		throttled[name] = {
			...entry,
			resolve: (input) =>
				Effect.gen(function* () {
					const limiter = yield* RateLimiter;
					const {actor} = yield* CurrentActor;
					yield* limiter.check(actor);
					return yield* entry.resolve(input);
				}),
		};
	}
	return throttled as M;
};
