/**
 * The ceiling itself, over a wait that settles and one that never does. Both run inside an
 * `acquireRelease` finalizer, because uninterruptibility is the whole reason the ceiling is a timer
 * rather than `Effect.timeout` — a bound proven on an ordinary effect would not be the bound this
 * module claims.
 */

import {assert, describe, it} from "@effect/vitest";
import {Duration, Effect, Fiber} from "effect";
import {boundedTeardown} from "./teardown.ts";

const CEILING = Duration.millis(60);

const closing = (release: Effect.Effect<void>) =>
	Effect.acquireRelease(Effect.void, () => release).pipe(Effect.scoped);

describe("a bounded teardown wait", () => {
	it.live("returns as soon as the wait settles", () =>
		Effect.gen(function* () {
			const started = Date.now();
			yield* closing(boundedTeardown("a wait that settles", (settled) => settled(), CEILING));
			assert.isBelow(
				Date.now() - started,
				Duration.toMillis(CEILING),
				"a settled wait paid the ceiling instead of returning on the callback",
			);
		}),
	);

	it.live("gives a wait that never settles up at the ceiling", () =>
		Effect.gen(function* () {
			const started = Date.now();
			yield* closing(boundedTeardown("a wait that never settles", () => {}, CEILING));
			const elapsed = Date.now() - started;
			assert.isAtLeast(elapsed, Duration.toMillis(CEILING) - 5, "the ceiling was not waited out");
			assert.isBelow(
				elapsed,
				Duration.toMillis(CEILING) * 10,
				"the finalizer did not return at its ceiling",
			);
		}),
	);

	it.live("still runs the wait when the stop arrived as an interrupt", () =>
		Effect.gen(function* () {
			let waited = false;
			const fiber = yield* Effect.forkChild(
				Effect.acquireRelease(Effect.void, () =>
					boundedTeardown(
						"a wait under an interrupt",
						(settled) => {
							waited = true;
							settled();
						},
						CEILING,
					),
				).pipe(Effect.andThen(Effect.never), Effect.scoped),
			);
			yield* Effect.sleep(Duration.millis(20));
			yield* Fiber.interrupt(fiber);
			assert.isTrue(waited, "the interrupted stop skipped the finalizer's wait");
		}),
	);
});
