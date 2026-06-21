/**
 * `resolveWire` — drive ONE fate operation through its real external interface
 * (`resolve` → `encodeWireError(failureOf(cause))`), the same two seams the
 * `/fate` route crosses, with NO database and NO `ManagedRuntime`.
 *
 * A per-feature unit test that calls `op.handler(...)` and asserts the typed
 * failure CLASS (`Unauthorized`) stops one layer beneath the interface a client
 * sees: it never crosses the seam that maps the class to its wire `code`
 * (`UNAUTHORIZED`) via the `ErrorCode` annotation. A mis-annotated handler error
 * (wrong/missing `[ErrorCode]`) passes such a test. Driving through `resolveWire`
 * exercises both seams — the definition's input/args Schema decode AND
 * `encodeWireError` — so the class→wire-code translation is proven locally.
 *
 * This is the no-DB slice of `Executor.ts`'s `runResolve` (`resolve` → `Effect.exit`
 * → on failure `encodeWireError(failureOf(cause))`) lifted to an `it.effect`-native
 * shape — no worker runtime / Effect→Promise conversion, since those carry nothing
 * for a no-DB gate assertion. It is the lighter in-process resolve/wire seam, not
 * the heavyweight `runFateOp` interpreter harness (see effect-testing.md).
 *
 * The op's real `R` is preserved (`FateQuery`/`FateList`/`FateMutation`, not the
 * type-erased `Any*` shapes) so the caller's `provideService` / `Effect.provide`
 * discharges it to `never` — exactly as it did when driving `.handler`. The wire
 * failure stays a typed `FateRequestError` (the `E` channel), so `Effect.exit` +
 * `Cause.findErrorOption` reads its `.code`.
 */
import {encodeWireError, failureOf} from "@kampus/fate-effect";
import type {FateRequestError} from "@nkzw/fate/server";
import {Effect, Exit} from "effect";

/**
 * The external interface of any fate op (query/list/mutation): its `resolve`
 * decode-then-run wrapper. Captured structurally over the op's `resolve` so a
 * caller passes the op record itself (`queries.me`, `mutations["x.y"]`) and the
 * op's real success `A`, error `E`, services `R`, and wire-input shape `In` all
 * infer — `R` discharges through the caller's `provideService`/`Effect.provide`
 * exactly as it did when driving `.handler`.
 */
interface ResolvableOp<In, A, E, R> {
	readonly resolve: (input: In) => Effect.Effect<A, E, R>;
}

/**
 * Run `op.resolve(rawWireInput)` and return its `Exit` mapped through the wire
 * seam: on success the handler value, on failure the `FateRequestError`
 * `encodeWireError` derives — exactly what a client receives. The caller still
 * provides the same per-request services (`CurrentUser`, the substituted
 * `Drizzle`/service seams) it provided to `.handler`.
 */
export const resolveWire = <In, A, E, R>(
	op: ResolvableOp<In, A, E, R>,
	raw: In,
): Effect.Effect<A, FateRequestError, R> =>
	op.resolve(raw).pipe(
		Effect.exit,
		Effect.flatMap((exit) =>
			Exit.isSuccess(exit)
				? Effect.succeed(exit.value)
				: Effect.fail(encodeWireError(failureOf(exit.cause))),
		),
	);
