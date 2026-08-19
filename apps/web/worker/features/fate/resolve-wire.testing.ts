/**
 * Drive ONE fate op through the two seams a client crosses — input decode and
 * `encodeWireError` — with no DB and no `ManagedRuntime`. Why this rather than
 * `.handler`: .patterns/effect-testing.md §"Per-feature op tests".
 */
import {encodeWireError, failureOf} from "@kampus/fate-effect";
import type {FateRequestError} from "@nkzw/fate/server";
import {Effect, Exit, Layer} from "effect";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {PanoFeedCache} from "../pano/feed-cache.ts";

/**
 * A unit test drives one op with no real request, so it carries no override cookie
 * (#622). `null` is "no local override" — the environment gate stays in
 * `makeRequestFlagsContext`, so this is never a capability.
 */
const NO_COOKIE_OVERRIDES = RequestFlagOverrides.of({
	cookieHeader: null,
	overridesAllowed: false,
});

/** For a test that drives a flag-gated effect directly, not through {@link resolveWire}. */
export const noRequestFlagOverrides: Layer.Layer<RequestFlagOverrides> = Layer.succeed(
	RequestFlagOverrides,
	NO_COOKIE_OVERRIDES,
);

/**
 * The cache twin of {@link noRequestFlagOverrides} (#2324, ADR 0170). A unit test has no
 * real execution context, so the purge is a no-op.
 */
export const noopPanoFeedCache: Layer.Layer<PanoFeedCache> = Layer.succeed(PanoFeedCache, {
	purge: () => Effect.void,
});

/** Structural over `resolve` so a caller passes the op record itself and every type infers. */
interface ResolvableOp<In, A, E, R> {
	readonly resolve: (input: In) => Effect.Effect<A, E, R>;
}

export const resolveWire = <In, A, E, R>(
	op: ResolvableOp<In, A, E, R>,
	raw: In,
): Effect.Effect<A, FateRequestError, Exclude<R, RequestFlagOverrides | PanoFeedCache>> =>
	op.resolve(raw).pipe(
		Effect.exit,
		Effect.flatMap((exit) =>
			Exit.isSuccess(exit)
				? Effect.succeed(exit.value)
				: Effect.fail(encodeWireError(failureOf(exit.cause))),
		),
		// One merged provide, so the residual `R` stays a single-union `Exclude`.
		Effect.provide(Layer.mergeAll(noRequestFlagOverrides, noopPanoFeedCache)),
	);
