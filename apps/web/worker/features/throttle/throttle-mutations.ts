/**
 * Wraps every mutation's `resolve` with the per-actor throttle (ADR 0177), applied
 * once at the fate composition root so it reaches every feature without touching
 * one. The token is spent BEFORE the handler runs, so a denied mutation executes
 * nothing at all — neither its write nor its live publish — which is what keeps a
 * throttled mutation transparent to the fanout invariant.
 */
import {CurrentActor} from "@kampus/authz";
import type {AnyFateMutation, FateMutationsRecord} from "@kampus/fate-effect";
import {Effect} from "effect";
import {RateLimiter} from "./RateLimiter.ts";

// The wrapped `resolve` really gains `RateLimiter` + `CurrentActor`, but the return
// type stays `M` because both are provided at run time (ADR 0107 §7) — the same re-pin
// the fate provision pipeline applies to every erased entry effect.
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
