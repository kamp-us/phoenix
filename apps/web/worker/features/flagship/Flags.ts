/**
 * `Flags` — the domain-facing feature-flag service (epic #488, child #508): the
 * boolean dark-ship primitive. Server code reads `flags.getBoolean(key, default)`
 * to gate a code path behind a flag.
 *
 * Two contracts are load-bearing here:
 *
 * 1. **Safe-default, baked in.** The caller MUST pass a `default`, and that
 *    default is the off/old/safe path. The read NEVER fails: a `FlagshipError`
 *    (a misconfigured binding, an unreachable Flagship) is caught and collapsed
 *    to the supplied default, so a Flagship outage degrades safe rather than
 *    breaking the request. The public method's error channel is therefore
 *    `never` — no `FlagshipError` leaks to callers.
 * 2. **Clean OpenFeature seam.** Domain code depends on THIS interface, not on
 *    alchemy's `Cloudflare.Flagship*` types, so a future provider swap
 *    (OpenFeature is the hedge — #506) re-wires only `FlagsLive`, not the
 *    call-sites. The alchemy `FlagshipClient` stays an implementation detail
 *    consumed under the `Flagship` Tag (the #507 seam — this never re-binds it).
 *
 * Scope is the boolean read only; typed variations (string/number/object) are
 * #509, the React hook is #510, targeting/percentage is #511.
 */
import type {RuntimeContext} from "alchemy";
import {Context, Effect, Layer} from "effect";
import {FlagsContext, toEvaluationContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";

/** The domain-facing flag service value — provider-agnostic by construction. */
export interface FlagsAccess {
	/**
	 * Read a boolean flag for the current request, falling back to `defaultValue`
	 * on any evaluation error. The per-request {@link FlagsContext} (user identity
	 * for stable bucketing) is read from the environment — supplied per request
	 * alongside `Auth` (ADR 0029), not captured at isolate scope. `RuntimeContext`
	 * is the alchemy binding's intrinsic ambient requirement, discharged at worker
	 * scope (#507); it is generic alchemy, not a leaked Flagship type.
	 */
	readonly getBoolean: (
		key: string,
		defaultValue: boolean,
	) => Effect.Effect<boolean, never, FlagsContext | RuntimeContext>;
}

export class Flags extends Context.Service<Flags, FlagsAccess>()("@kampus/Flags") {}

/**
 * Resolved once per isolate from the init-bound `Flagship` client (the #507
 * seam). The client is captured at layer build, so `getBoolean`'s only
 * per-request requirement is the `FlagsContext` it reads at call time.
 */
export const FlagsLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		return Flags.of({
			getBoolean: (key, defaultValue) =>
				Effect.gen(function* () {
					const context = yield* FlagsContext;
					return yield* flagship
						.getBooleanValue(key, defaultValue, toEvaluationContext(context))
						// Any `FlagshipError` (misconfigured/unreachable binding) collapses to
						// the supplied default — the safe-default contract that makes a
						// Flagship outage degrade safe (contract 1 above).
						.pipe(Effect.catch(() => Effect.succeed(defaultValue)));
				}),
		});
	}),
);
