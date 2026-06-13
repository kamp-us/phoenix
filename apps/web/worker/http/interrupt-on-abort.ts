/**
 * `interruptOnAbort` — the platform-edge abort→interruption wiring for the routes
 * in `app.ts` (ADR 0043). alchemy's worker bridge runs the request handler with
 * `Effect.runPromiseExit` and wires no signal, so the HTTP edge owns abort itself
 * — the same mechanism effect-smol's `HttpEffect.toWebHandlerWith` uses (listen on
 * `request.signal`, interrupt the fiber). Infrastructure, not a route.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * The subset of `AbortSignal` the wiring reads. Structural on purpose: a unit
 * test can model an abort dispatched inside the pre-check→listener gap (not
 * deterministically reachable through a real `AbortController`) without a cast.
 */
export type AbortSignalLike = Pick<
	AbortSignal,
	"aborted" | "addEventListener" | "removeEventListener"
>;

/**
 * Run `program` as a child of the current (request) fiber, interrupted when
 * `signal` aborts. The child inherits the fiber context, so spans/services flow
 * through.
 */
export const interruptOnAbort =
	(signal: AbortSignalLike) =>
	<A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			if (signal.aborted) {
				return yield* Effect.interrupt;
			}
			const fiber = yield* Effect.forkChild(program);
			const onAbort = () => fiber.interruptUnsafe();
			signal.addEventListener("abort", onAbort, {once: true});
			// `Effect.forkChild` is a fiber yield point, so there is a gap between the
			// pre-check above and `addEventListener`. An abort dispatched in that gap
			// fires no listener — re-check and interrupt directly (idempotent with
			// `onAbort` if both run).
			if (signal.aborted) {
				fiber.interruptUnsafe();
			}
			return yield* Fiber.join(fiber).pipe(
				Effect.onExit(() => Effect.sync(() => signal.removeEventListener("abort", onAbort))),
			);
		});
