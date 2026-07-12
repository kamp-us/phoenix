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
 * Scope is the read surface — the boolean dark-ship primitive plus the typed
 * variations (string/number/object, #509). The React hook is #510,
 * targeting/percentage is #511.
 */
import type {RuntimeContext} from "alchemy";
import {type Cause, Context, Effect, Layer} from "effect";
import {FlagOverrideStore} from "./FlagOverrideStore.ts";
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

	/**
	 * Read a string flag for the current request. Same safe-default/never-throws
	 * contract as {@link getBoolean}: any evaluation error collapses to
	 * `defaultValue`, so the error channel is `never`.
	 */
	readonly getString: (
		key: string,
		defaultValue: string,
	) => Effect.Effect<string, never, FlagsContext | RuntimeContext>;

	/**
	 * Read a number flag for the current request. Same safe-default/never-throws
	 * contract as {@link getBoolean}.
	 */
	readonly getNumber: (
		key: string,
		defaultValue: number,
	) => Effect.Effect<number, never, FlagsContext | RuntimeContext>;

	/**
	 * Read a JSON-object flag for the current request. `T` is constrained to
	 * `object` to match the provider's typed read; same safe-default/never-throws
	 * contract as {@link getBoolean}.
	 */
	readonly getObject: <T extends object>(
		key: string,
		defaultValue: T,
	) => Effect.Effect<T, never, FlagsContext | RuntimeContext>;
}

export class Flags extends Context.Service<Flags, FlagsAccess>()("@kampus/Flags") {}

/**
 * Collapse any evaluation failure to the caller's safe default — the single site
 * of contract 1 (safe-default, error channel `never`). `catchCause` (not a typed
 * `catch`) so a binding DEFECT degrades safe too, matching the fire-and-forget
 * swallow-with-log idiom of the bildirim emitters (`swallow`). The discarded cause
 * is now LOGGED (`logWarning`) before the default is returned, so a misconfigured
 * or unreachable Flagship binding is observable instead of silently absorbed
 * (#2685) — the safe-default behavior is unchanged, only the silence is removed.
 * A telemetry counter is deliberately out of scope here (it rides #1821).
 */
const swallowToDefault = <A>(key: string, defaultValue: A) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) =>
		Effect.logWarning(`flags: evaluation of "${key}" failed — falling back to default`, cause).pipe(
			Effect.as(defaultValue),
		),
	);

/**
 * Build the real {@link FlagsAccess} over a resolved `Flagship` client — the
 * per-isolate read surface, captured at layer build so each read's only
 * per-request requirement is the `FlagsContext` it reads at call time. Extracted
 * from the layer so `FlagsDevOverrideLive` can decorate the same surface (#622).
 */
const buildRealFlags = (flagship: Flagship["Service"]): FlagsAccess => ({
	getBoolean: (key, defaultValue) =>
		Effect.gen(function* () {
			const context = yield* FlagsContext;
			return yield* flagship
				.getBooleanValue(key, defaultValue, toEvaluationContext(context))
				.pipe(swallowToDefault(key, defaultValue));
		}),
	getString: (key, defaultValue) =>
		Effect.gen(function* () {
			const context = yield* FlagsContext;
			return yield* flagship
				.getStringValue(key, defaultValue, toEvaluationContext(context))
				.pipe(swallowToDefault(key, defaultValue));
		}),
	getNumber: (key, defaultValue) =>
		Effect.gen(function* () {
			const context = yield* FlagsContext;
			return yield* flagship
				.getNumberValue(key, defaultValue, toEvaluationContext(context))
				.pipe(swallowToDefault(key, defaultValue));
		}),
	getObject: (key, defaultValue) =>
		Effect.gen(function* () {
			const context = yield* FlagsContext;
			return yield* flagship
				.getObjectValue(key, defaultValue, toEvaluationContext(context))
				.pipe(swallowToDefault(key, defaultValue));
		}),
});

/**
 * Resolved once per isolate from the init-bound `Flagship` client (the #507
 * seam). The client is captured at layer build, so `getBoolean`'s only
 * per-request requirement is the `FlagsContext` it reads at call time.
 */
export const FlagsLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		return Flags.of(buildRealFlags(flagship));
	}),
);

/**
 * Decorate a real {@link FlagsAccess} with the dev-only local override (#622): a
 * boolean read whose key is present in the per-request `FlagsContext.overrides`
 * returns the forced value; every other read (and every typed/non-boolean read)
 * delegates unchanged to `inner`. Overrides are boolean-only — the local-flip
 * surface forces a dark-ship boolean on/off; typed variations stay on real eval.
 *
 * Pure decorator (no Layer) so the short-circuit is unit-testable over a stub
 * `FlagsAccess` without a binding. The wrapper this powers (`FlagsDevOverrideLive`)
 * is installed ONLY in development (`http/app.ts`); `inner.getBoolean` still reads
 * `FlagsContext`, so the decorated read's per-request requirement is unchanged.
 */
export const withDevOverrides = (inner: FlagsAccess): FlagsAccess => ({
	...inner,
	getBoolean: (key, defaultValue) =>
		Effect.gen(function* () {
			const {overrides} = yield* FlagsContext;
			const override = overrides?.[key];
			return override !== undefined ? override : yield* inner.getBoolean(key, defaultValue);
		}),
});

/**
 * The dev-only override `Flags` layer (#622): `FlagsLive`'s surface decorated with
 * {@link withDevOverrides}. Built from the same init-bound `Flagship` client, so it
 * is a drop-in replacement for `FlagsLive` in the per-request set — `http/app.ts`
 * picks this layer instead of `FlagsLive` ONLY when `environment === "development"`.
 * In any deployed stage this layer is never built, so the override branch is
 * structurally absent from the prod flag path (the load-bearing #622 gate).
 */
export const FlagsDevOverrideLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		return Flags.of(withDevOverrides(buildRealFlags(flagship)));
	}),
);

/**
 * Decorate a real {@link FlagsAccess} with the DURABLE, all-stages runtime override
 * (admin-console epic #2711, #2741): a boolean read whose key carries an active
 * `FlagOverrideStore` override returns the forced value; every other read (and every
 * typed/non-boolean read) delegates unchanged to `inner`.
 *
 * Unlike {@link withDevOverrides} (a dev-only, per-request cookie map), this reads the
 * durable, `requireAdmin`-written, append-only-projected override store — the admin's
 * in-app flip persisted in D1, honored in EVERY stage. `store.getActiveOverride` is
 * fail-soft (`E = never`): a store outage resolves `undefined`, so the read delegates to
 * `inner` and a Flagship outage still degrades to the caller's safe default — the override
 * layer never turns the never-throwing flag contract fail-open (epic #2711 story 8). Pure
 * decorator (no Layer) so the short-circuit is unit-testable over stub `FlagsAccess` +
 * store, with no binding.
 */
export const withRuntimeOverrides = (
	inner: FlagsAccess,
	store: FlagOverrideStore["Service"],
): FlagsAccess => ({
	...inner,
	getBoolean: (key, defaultValue) =>
		Effect.gen(function* () {
			const override = yield* store.getActiveOverride(key);
			return override !== undefined ? override : yield* inner.getBoolean(key, defaultValue);
		}),
});

/**
 * The durable runtime-override `Flags` layer (#2741): `FlagsLive`'s surface decorated with
 * {@link withRuntimeOverrides}. Installed on EVERY stage (the admin console operates on local
 * AND prod), so the override branch is present in every deployed flag path — the opposite of
 * the dev-only {@link FlagsDevOverrideLive} gate. Requires `Flagship` + `FlagOverrideStore`,
 * both discharged at the composition root (`fate/layers.ts`).
 */
export const FlagsRuntimeOverrideLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		const store = yield* FlagOverrideStore;
		return Flags.of(withRuntimeOverrides(buildRealFlags(flagship), store));
	}),
);

/**
 * The `development`-stage flag layer: the durable runtime override composed UNDER the dev-only
 * cookie override, so a local dev's `phoenix_flag_overrides` cookie flip (#622) still wins
 * outermost, falling through to the durable admin override, then the real evaluation. In every
 * deployed stage {@link FlagsRuntimeOverrideLive} (no dev-cookie branch) is built instead — the
 * same fail-closed dev-only gate the raw path applies, now over the runtime-override base.
 */
export const FlagsDevAndRuntimeOverrideLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		const store = yield* FlagOverrideStore;
		return Flags.of(withDevOverrides(withRuntimeOverrides(buildRealFlags(flagship), store)));
	}),
);
