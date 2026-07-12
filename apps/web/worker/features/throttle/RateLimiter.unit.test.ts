/**
 * `RateLimiter` service coverage (ADR 0177) — the per-actor mutation budget over
 * the real in-isolate store and `TestClock`: an actor under the ceiling is
 * allowed, at the ceiling is denied with `RATE_LIMIT_EXCEEDED`, refills over
 * time, buckets are per-actor, and anonymous traffic is never throttled here.
 */
import {assert, describe, it} from "@effect/vitest";
import {human, unauthenticated} from "@kampus/authz";
import {failureOf, wireCodeOf} from "@kampus/fate-effect";
import {Effect, Exit, Layer} from "effect";
import {TestClock} from "effect/testing";
import {DEFAULT_MUTATION_POLICY, RateLimiter, RateLimiterLive} from "./RateLimiter.ts";
import {InIsolateRateLimitStoreLive} from "./RateLimitStore.ts";

const TestRateLimiter = RateLimiterLive.pipe(Layer.provide(InIsolateRateLimitStoreLive));
const CAPACITY = DEFAULT_MUTATION_POLICY.capacity;

describe("RateLimiter — per-actor mutation budget (ADR 0177)", () => {
	it.effect("under the ceiling every write is allowed; the write past it is denied", () =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiter;
			const actor = human("u-flooder");
			for (let i = 0; i < CAPACITY; i++) yield* limiter.check(actor);
			const exit = yield* limiter.check(actor).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				assert.strictEqual(wireCodeOf(failureOf(exit.cause)), "RATE_LIMIT_EXCEEDED");
			}
		}).pipe(Effect.provide(TestRateLimiter)),
	);

	it.effect("the bucket refills over time — a denied actor is allowed again after the window", () =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiter;
			const actor = human("u-steady");
			for (let i = 0; i < CAPACITY; i++) yield* limiter.check(actor);
			assert.isTrue(Exit.isFailure(yield* limiter.check(actor).pipe(Effect.exit)));
			yield* TestClock.adjust("1 seconds"); // one token back at 1/s
			assert.isTrue(Exit.isSuccess(yield* limiter.check(actor).pipe(Effect.exit)));
		}).pipe(Effect.provide(TestRateLimiter)),
	);

	it.effect("each actor gets an independent bucket", () =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiter;
			for (let i = 0; i < CAPACITY; i++) yield* limiter.check(human("u-a"));
			// u-a is drained; u-b is untouched and still allowed
			assert.isTrue(Exit.isSuccess(yield* limiter.check(human("u-b")).pipe(Effect.exit)));
		}).pipe(Effect.provide(TestRateLimiter)),
	);

	it.effect("anonymous traffic carries no budget key and is never throttled here", () =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiter;
			for (let i = 0; i < CAPACITY * 2; i++) yield* limiter.check(unauthenticated);
		}).pipe(Effect.provide(TestRateLimiter)),
	);
});
