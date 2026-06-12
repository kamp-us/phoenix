/**
 * `interruptOnAbort` — the platform-edge abort wiring for the routes
 * assembled in `app.ts` (ADR 0043). alchemy's worker bridge runs the request
 * handler with `Effect.runPromiseExit` and wires no signal, so the HTTP edge
 * owns abort→interruption itself (effect-smol's `HttpEffect.toWebHandlerWith`
 * idiom: `request.signal` listener → fiber interrupt). T0: pure helper, no
 * router, no workerd. Tests run on the Effect runtime (`it.effect`) — the
 * combinator is consumed as an Effect on the request fiber in production, so
 * the tests exercise it the same way; coordination uses a `Latch`, never
 * timers (a fixed tick raced fiber startup on loaded CI runners).
 */
import {assert, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import {describe} from "vitest";
import {type AbortSignalLike, interruptOnAbort} from "./interrupt-on-abort.ts";

describe("interruptOnAbort", () => {
	it.effect("passes a completing program through untouched", () =>
		Effect.gen(function* () {
			const controller = new AbortController();
			const result = yield* Effect.succeed(42).pipe(interruptOnAbort(controller.signal));
			assert.strictEqual(result, 42);
			// A late abort (client gone after the response) must be a no-op.
			controller.abort();
		}),
	);

	it.effect("propagates a typed failure unchanged", () =>
		Effect.gen(function* () {
			const controller = new AbortController();
			const exit = yield* Effect.exit(
				Effect.fail("boom").pipe(interruptOnAbort(controller.signal)),
			);
			assert.deepStrictEqual(exit, Exit.fail("boom"));
		}),
	);

	it.effect("an abort mid-flight interrupts the program", () =>
		Effect.gen(function* () {
			const controller = new AbortController();
			// The program opens a latch as its first instruction; awaiting the
			// latch IS the deterministic "fiber is running" proof — the abort
			// below provably lands mid-flight, on any runner speed.
			const started = yield* Latch.make();
			const program = started.open.pipe(Effect.andThen(Effect.never));
			const fiber = yield* Effect.forkChild(program.pipe(interruptOnAbort(controller.signal)));
			yield* started.await;
			controller.abort();
			const exit = yield* Fiber.await(fiber);
			assert.isTrue(Exit.isFailure(exit) && Exit.hasInterrupts(exit));
		}),
	);

	it.effect(
		"an abort dispatched in the pre-check→listener gap still interrupts (recheck branch)",
		() =>
			Effect.gen(function* () {
				// `Effect.forkChild` is a fiber yield point between the `signal.aborted`
				// pre-check and `addEventListener` — an abort dispatched in that gap
				// fires no listener. A real AbortController can't hit the gap
				// deterministically, so simulate exactly what it looks like from the
				// helper's view: `aborted` reads false at the pre-check and true after,
				// and the registered listener never fires (the event already dispatched).
				let aborted = false;
				const gapSignal: AbortSignalLike = {
					get aborted() {
						const value = aborted;
						aborted = true; // flips after the first (pre-check) read
						return value;
					},
					// Registered too late: the event already dispatched, so the listener
					// is never invoked — only the recheck can interrupt.
					addEventListener: () => {},
					removeEventListener: () => {},
				};
				const exit = yield* Effect.exit(Effect.never.pipe(interruptOnAbort(gapSignal)));
				assert.isTrue(Exit.isFailure(exit) && Exit.hasInterrupts(exit));
			}),
	);

	it.effect("an already-aborted signal interrupts before the program starts", () =>
		Effect.gen(function* () {
			const controller = new AbortController();
			controller.abort();
			let started = false;
			const program = Effect.suspend(() => {
				started = true;
				return Effect.succeed("never seen");
			});
			const exit = yield* Effect.exit(program.pipe(interruptOnAbort(controller.signal)));
			assert.isFalse(started);
			assert.isTrue(Exit.isFailure(exit) && Exit.hasInterrupts(exit));
		}),
	);
});
