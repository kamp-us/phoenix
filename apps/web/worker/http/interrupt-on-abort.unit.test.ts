/**
 * Tests for `interruptOnAbort` (T0: pure helper, no router, no workerd). Run on
 * the Effect runtime (`it.effect`), exercising the combinator the same way
 * production does. Coordination uses a `Latch`, never timers (a fixed tick raced
 * fiber startup on loaded CI runners).
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
			// Awaiting the latch the program opens first IS the deterministic
			// "fiber is running" proof — the abort below provably lands mid-flight.
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
				// A real AbortController can't hit the pre-check→listener gap
				// deterministically, so simulate the helper's view of it: `aborted`
				// reads false at the pre-check then true after, and the listener never
				// fires (event already dispatched) — only the recheck can interrupt.
				let aborted = false;
				const gapSignal: AbortSignalLike = {
					get aborted() {
						const value = aborted;
						aborted = true; // flips after the first (pre-check) read
						return value;
					},
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
