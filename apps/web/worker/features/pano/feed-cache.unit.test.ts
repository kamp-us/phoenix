/**
 * `panoFeedCacheFor` — the base-feed edge-cache purger (leg B, #2324, ADR 0170). The
 * contract under test mirrors `live-publisher.unit.test.ts` (its cache-side twin):
 *
 *   1. enabled ⇒ `purge()` schedules ONE `cache.purge({tags: ["pano-feed"]})` through
 *      `waitUntil`, never awaited on the mutation path;
 *   2. disabled (flag off) ⇒ `purge()` schedules NOTHING and touches no capability
 *      (AC#5: flag off ⇒ no purge calls);
 *   3. `purge()`'s error channel is `never` — a rejecting purge cannot fail the caller;
 *   4. a synchronously-throwing execution context (`waitUntil` throws) is swallowed too.
 *
 * Unit tier (ADR 0082): stubs at the `purge`/`waitUntil` seam, zero platform fake.
 */
import {assert, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import * as Schema from "effect/Schema";
import {expectTypeOf, vi} from "vitest";
import {PANO_FEED_CACHE_TAG, panoFeedCacheFor} from "./feed-cache.ts";

/** A rejection from the test harness flush thunk — dies the fiber. */
class FlushRejected extends Schema.TaggedErrorClass<FlushRejected>()("test/FlushRejected", {
	cause: Schema.Unknown,
}) {}

interface PurgeCall {
	readonly tags: string[];
}

/**
 * Build a purger over stubbed seams: `purge` defaults to a recorder, `waitUntil`
 * collects the scheduled promises so a test can `flush` the fire-and-forget work.
 */
function makeHarness(opts?: {
	enabled?: boolean;
	purge?: (options: {tags: string[]}) => Promise<unknown>;
}) {
	const purges: Array<PurgeCall> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const cache = panoFeedCacheFor({
		enabled: opts?.enabled ?? true,
		purge:
			opts?.purge ??
			((options) => {
				purges.push({tags: options.tags});
				return Promise.resolve({success: true});
			}),
		waitUntil: (promise) => {
			scheduled.push(promise);
		},
	});
	const flush = () => Promise.allSettled(scheduled);
	return {cache, purges, scheduled, flush};
}

it.effect("enabled ⇒ one tag purge scheduled through waitUntil", () =>
	Effect.gen(function* () {
		const {cache, purges, scheduled, flush} = makeHarness();

		yield* cache.purge();
		// scheduled synchronously, but the delivery is not awaited on the caller path
		assert.strictEqual(scheduled.length, 1);
		yield* Effect.tryPromise({try: flush, catch: (cause) => new FlushRejected({cause})}).pipe(
			Effect.orDie,
		);

		assert.deepStrictEqual(purges, [{tags: [PANO_FEED_CACHE_TAG]}]);
	}),
);

it.effect("disabled (flag off) ⇒ no purge scheduled, no capability touched", () =>
	Effect.gen(function* () {
		let purgeCalls = 0;
		const {cache, scheduled} = makeHarness({
			enabled: false,
			purge: () => {
				purgeCalls += 1;
				return Promise.resolve();
			},
		});

		yield* cache.purge();

		assert.strictEqual(scheduled.length, 0);
		assert.strictEqual(purgeCalls, 0);
	}),
);

it("purge()'s error channel is `never` — the no-fail contract is the type", () => {
	const {cache} = makeHarness();
	expectTypeOf<Effect.Error<ReturnType<typeof cache.purge>>>().toEqualTypeOf<never>();
});

it.effect("a rejecting purge cannot fail the calling effect", () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	return Effect.gen(function* () {
		const {cache, flush} = makeHarness({
			purge: () => Promise.reject(new Error("cache unreachable")),
		});

		const exit = yield* Effect.exit(cache.purge());
		assert.isTrue(Exit.isSuccess(exit));

		yield* Effect.tryPromise({try: flush, catch: (cause) => new FlushRejected({cause})}).pipe(
			Effect.orDie,
		); // the detached rejection stays off the caller
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				errorSpy.mockRestore();
			}),
		),
	);
});

it.effect("a synchronously-throwing execution context is swallowed too", () =>
	Effect.gen(function* () {
		let attempts = 0;
		const cache = panoFeedCacheFor({
			enabled: true,
			purge: () => Promise.resolve(),
			waitUntil: () => {
				attempts += 1;
				// biome-ignore lint/plugin: throw is in a nested plain closure (test stub), not the Effect.gen body — lexical matcher can't exempt
				throw new Error("execution context gone");
			},
		});

		const exit = yield* Effect.exit(cache.purge());
		assert.strictEqual(attempts, 1); // the schedule was attempted (and threw)
		assert.isTrue(Exit.isSuccess(exit)); // yet the calling effect succeeded
	}),
);
