/**
 * `Flags` — the domain-facing feature-flag read surface: .patterns/feature-flags.md.
 *
 * Every read takes a `default` that is the off/old/safe path, and any evaluation error
 * collapses to it — so the error channel is `never` and a Flagship outage degrades safe.
 * Domain code depends on THIS interface, never on alchemy's `Cloudflare.Flagship*` types.
 */
import type {RuntimeContext} from "alchemy";
import {type Cause, Context, Effect, Layer} from "effect";
import {tagFlag} from "../../lib/sentry.ts";
import {FlagsContext, toEvaluationContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";

export interface FlagsAccess {
	/**
	 * The per-request {@link FlagsContext} is read from the environment, not captured at
	 * isolate scope (ADR 0029). `RuntimeContext` is the alchemy binding's ambient
	 * requirement, discharged at worker scope — generic alchemy, not a leaked Flagship type.
	 */
	readonly getBoolean: (
		key: string,
		defaultValue: boolean,
	) => Effect.Effect<boolean, never, FlagsContext | RuntimeContext>;

	readonly getString: (
		key: string,
		defaultValue: string,
	) => Effect.Effect<string, never, FlagsContext | RuntimeContext>;

	readonly getNumber: (
		key: string,
		defaultValue: number,
	) => Effect.Effect<number, never, FlagsContext | RuntimeContext>;

	readonly getObject: <T extends object>(
		key: string,
		defaultValue: T,
	) => Effect.Effect<T, never, FlagsContext | RuntimeContext>;
}

export class Flags extends Context.Service<Flags, FlagsAccess>()("@kampus/Flags") {}

/**
 * The single site of the safe-default contract. `catchCause`, not a typed `catch`, so a
 * binding DEFECT degrades safe too; the discarded cause is logged so a misconfigured or
 * unreachable Flagship binding is observable instead of silently absorbed.
 */
const swallowToDefault = <A>(key: string, defaultValue: A) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) =>
		Effect.logWarning(`flags: evaluation of "${key}" failed — falling back to default`, cause).pipe(
			Effect.as(defaultValue),
		),
	);

/** Extracted from the layer so `FlagsDevOverrideLive` can decorate the same surface. */
const buildRealFlags = (flagship: Flagship["Service"]): FlagsAccess => ({
	getBoolean: (key, defaultValue) =>
		Effect.gen(function* () {
			const context = yield* FlagsContext;
			return yield* flagship
				.getBooleanValue(key, defaultValue, toEvaluationContext(context))
				.pipe(swallowToDefault(key, defaultValue));
		}).pipe(
			// THE per-request boolean choke point, so stamping the resolved value as the Sentry tag
			// `flag.<key>` attributes an error in ANY flag-gated worker path, not just the
			// `/api/flags/evaluate` seam. Inert without an active Sentry client; non-PII.
			Effect.tap((value) => Effect.sync(() => tagFlag(key, value))),
		),
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

/** The client is captured at layer build, so a read's only per-request need is `FlagsContext`. */
export const FlagsLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		return Flags.of(buildRealFlags(flagship));
	}),
);

/**
 * Dev-only local override: a boolean read whose key is present in `FlagsContext.overrides`
 * returns the forced value; every other read delegates to `inner`. Overrides are
 * boolean-only. A pure decorator (no Layer) so the short-circuit is unit-testable.
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
 * `http/app.ts` picks this over `FlagsLive` ONLY when `environment === "development"`, so
 * in any deployed stage the layer is never built and the override branch is structurally
 * absent from the prod flag path.
 */
export const FlagsDevOverrideLive = Layer.effect(
	Flags,
	Effect.gen(function* () {
		const flagship = yield* Flagship;
		return Flags.of(withDevOverrides(buildRealFlags(flagship)));
	}),
);
