/**
 * The never-hang / safe-default-on-outage invariant (#2931, epic #2926, ADR 0179 §4):
 * `withNeverHangFallback` bounds the per-request boot resolve and degrades to the untransformed
 * asset — never hanging, never 500-ing the shell. The three arms under test:
 *
 *   1. a resolve that never completes (a dead/slow Flagship or D1) is bounded by
 *      SHELL_BOOT_READ_TIMEOUT and yields the untransformed asset;
 *   2. a resolve that FAILS (a Flagship/D1 error) also degrades to the untransformed asset;
 *   3. a resolve that succeeds passes its value straight through — the fallback is inert on the
 *      healthy path.
 *
 * The bound is driven by `TestClock` (no real 1s sleep): a forked fiber runs the guarded resolve,
 * the clock is adjusted past the timeout, then the exit is observed — the `cold-start-retry`
 * idiom. Unit tier (ADR 0082): pure Effect logic, no deployed worker / platform fake.
 */
import {assert, it} from "@effect/vitest";
import {Effect, Exit, Fiber} from "effect";
import {TestClock} from "effect/testing";
import {withNeverHangFallback} from "./shell-boot-route.ts";

/** The untransformed asset stand-in — the byte-identical fallback the guard must degrade to. */
const UNTRANSFORMED = "untransformed-asset";
/** The injected shell stand-in — what a healthy resolve produces instead of the fallback. */
const INJECTED = "injected-boot-shell";

/** A tagged stand-in for a Flagship/D1 resolve failure — the `E`-channel value the guard degrades on. */
class BootResolveError {
	readonly _tag = "BootResolveError";
}

/**
 * Run `effect` to its `Exit`, advancing the clock well past `SHELL_BOOT_READ_TIMEOUT` (1s) so a
 * never-completing resolve is bounded and settles — the `cold-start-retry` TestClock idiom.
 */
const runPastTimeout = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect);
		yield* TestClock.adjust("5 seconds");
		return yield* Fiber.join(fiber).pipe(Effect.exit);
	});

it.effect("a resolve that never completes is bounded → the untransformed asset (never hangs)", () =>
	Effect.gen(function* () {
		const exit = yield* runPastTimeout(withNeverHangFallback(Effect.never, UNTRANSFORMED));
		assert.deepStrictEqual(exit, Exit.succeed(UNTRANSFORMED));
	}),
);

it.effect("a resolve that FAILS (Flagship/D1 error) → the untransformed asset (safe default)", () =>
	Effect.gen(function* () {
		const exit = yield* runPastTimeout(
			withNeverHangFallback(Effect.fail(new BootResolveError()), UNTRANSFORMED),
		);
		assert.deepStrictEqual(exit, Exit.succeed(UNTRANSFORMED));
	}),
);

it.effect("a healthy resolve passes straight through — the fallback is inert", () =>
	Effect.gen(function* () {
		const exit = yield* runPastTimeout(
			withNeverHangFallback(Effect.succeed(INJECTED), UNTRANSFORMED),
		);
		assert.deepStrictEqual(exit, Exit.succeed(INJECTED));
	}),
);
