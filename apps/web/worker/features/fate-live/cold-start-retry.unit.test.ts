/**
 * `withColdStartRetry` / `withColdStartRetryFetch` — the cold-DO transport
 * resilience seam (#842, #1048). The contract under test:
 *
 *   1. a transport failure that survives the bounded retry becomes a typed
 *      `LiveTransportError` (the route renders 503), NEVER a raw defect/500;
 *   2. the two transport CHANNELS both land there: the RPC methods raise the
 *      `RpcCallError` on the FAILURE channel (`withColdStartRetry`), and the GET
 *      SSE-open `.fetch` raises it on the DEFECT channel (`withColdStartRetryFetch`,
 *      #1048 — alchemy's `Effect.promise`-wrapped fetcher dies on a cold-DO
 *      rejection instead of failing);
 *   3. a non-transport app error (a declared `E`, NOT `RpcCallError`) fails fast
 *      and passes through untouched — the retry/convert never masks it;
 *   4. success passes straight through.
 *
 * The bounded backoff is driven by `TestClock` (no real ~1.5s sleeps): a forked
 * fiber runs the wrapped call, the clock is adjusted past the whole window, then
 * the exit is observed.
 *
 * Unit tier (ADR 0082): pure logic over a stubbed cross-DO call, no platform fake.
 */
import {assert, it} from "@effect/vitest";
import {Cause, Effect, Exit, Fiber} from "effect";
import {TestClock} from "effect/testing";
import {
	LiveTransportError,
	withColdStartRetry,
	withColdStartRetryFetch,
} from "./cold-start-retry.ts";

/** The structural `RpcCallError` the alchemy stub raises (`cold-start-retry.ts`). */
const rpcCallError = (cause: unknown) => ({_tag: "RpcCallError" as const, cause});

/** A non-transport app error — a declared `E` that must NOT be retried/converted. */
class AppError {
	readonly _tag = "AppError";
	constructor(readonly detail: string) {}
}

/** Run `effect` to its `Exit`, advancing past the whole bounded backoff window. */
const runPastBackoff = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect);
		// The schedule is ~100/200/400/800ms across 4 retries (<1.6s total); one
		// generous adjust drains every sleep so the fiber settles.
		yield* TestClock.adjust("10 seconds");
		return yield* Fiber.join(fiber).pipe(Effect.exit);
	});

/** The single `Fail` reason's typed error, or `undefined` if the cause isn't one typed failure. */
const failureValue = (exit: Exit.Exit<unknown, unknown>): unknown => {
	if (Exit.isSuccess(exit)) {
		return undefined;
	}
	const fail = exit.cause.reasons.find(Cause.isFailReason);
	return fail?.error;
};

it.effect("withColdStartRetry: a surviving RpcCallError failure → LiveTransportError", () =>
	Effect.gen(function* () {
		const exit = yield* runPastBackoff(
			withColdStartRetry("subscribe", Effect.fail(rpcCallError(new Error("cold")))),
		);
		assert.isTrue(Exit.isFailure(exit));
		assert.instanceOf(failureValue(exit), LiveTransportError);
	}),
);

it.effect("withColdStartRetry: a non-transport app error fails fast, unconverted", () =>
	Effect.gen(function* () {
		const exit = yield* runPastBackoff(
			withColdStartRetry("subscribe", Effect.fail(new AppError("boom"))),
		);
		assert.isTrue(Exit.isFailure(exit));
		assert.instanceOf(failureValue(exit), AppError);
	}),
);

it.effect(
	"withColdStartRetryFetch: a transport DEFECT → LiveTransportError, not a die (#1048)",
	() =>
		Effect.gen(function* () {
			// The `.fetch` cold-DO rejection surfaces as a DEFECT (alchemy's
			// `Effect.promise`-wrapped fetcher), the exact escape that produced the raw
			// HTTP 500. It must now land as a typed FAILURE, never a defect at the boundary.
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.die(new Error("cold-do unreachable"))),
			);
			assert.isTrue(Exit.isFailure(exit));
			const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
			assert.isFalse(
				reasons.some(Cause.isDieReason),
				"the defect was lifted to a failure, not left as a die",
			);
			assert.instanceOf(failureValue(exit), LiveTransportError);
		}),
);

it.effect(
	"withColdStartRetryFetch: a declared HttpServerError-shaped E passes through unconverted",
	() =>
		Effect.gen(function* () {
			// The `.fetch` request-framing channel (`HttpServerError`/`RequestError`) is
			// NOT a cold-start signal — it stays on its own channel so the route can
			// `orDie` a real framing defect rather than mask it as a warmup 503.
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.fail(new AppError("framing"))),
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.instanceOf(failureValue(exit), AppError);
		}),
);

it.effect("withColdStartRetryFetch: success passes straight through", () =>
	Effect.gen(function* () {
		const exit = yield* runPastBackoff(withColdStartRetryFetch("open", Effect.succeed("ok")));
		assert.deepStrictEqual(exit, Exit.succeed("ok"));
	}),
);
