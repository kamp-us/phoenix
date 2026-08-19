/**
 * The never-hang / safe-default-on-outage invariant (ADR 0179 §4): `withNeverHangFallback`
 * bounds the per-request boot resolve and degrades to the untransformed asset — never
 * hanging, never 500-ing the shell — while passing a healthy resolve straight through.
 *
 * The bound is driven by `TestClock` (no real 1s sleep): a forked fiber runs the guarded
 * resolve, the clock is adjusted past the timeout, then the exit is observed.
 */
import {assert, it} from "@effect/vitest";
import {Effect, Exit, Fiber} from "effect";
import {TestClock} from "effect/testing";
import {withNeverHangFallback} from "./shell-boot-route.ts";

const UNTRANSFORMED = "untransformed-asset";
const INJECTED = "injected-boot-shell";

class BootResolveError {
	readonly _tag = "BootResolveError";
}

/** Advances the clock well past `SHELL_BOOT_READ_TIMEOUT` so a never-completing resolve settles. */
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
