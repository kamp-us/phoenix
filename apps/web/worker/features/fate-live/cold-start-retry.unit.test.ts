/**
 * The cold-DO transport resilience seam (#842, #1048). The two wrappers differ by
 * channel: the RPC methods raise `RpcCallError` on the FAILURE channel, while the
 * SSE-open `.fetch` raises it on the DEFECT channel, because alchemy's
 * `Effect.promise`-wrapped fetcher dies on a cold-DO rejection instead of failing.
 */
import {assert, it} from "@effect/vitest";
import {Cause, Effect, Exit, Fiber} from "effect";
import {TestClock} from "effect/testing";
import {
	isNonTransportDefect,
	LiveTransportError,
	withColdStartRetry,
	withColdStartRetryFetch,
} from "./cold-start-retry.ts";

// Alchemy's real emitted shape, grounded in `alchemy/Cloudflare/Workers/Rpc.ts`. The
// class is unexported, so this hand-built fixture is the closest pin available and
// carries the FULL field set — keep it in sync with that file (#1367).
const rpcCallError = (cause: unknown, method = "open") => ({
	_tag: "RpcCallError" as const,
	method,
	cause,
});

class AppError {
	readonly _tag = "AppError";
	readonly detail: string;
	constructor(detail: string) {
		this.detail = detail;
	}
}

const runPastBackoff = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect);
		// The schedule is ~100/200/400/800ms across 4 retries, so one generous adjust
		// drains every sleep and the fiber settles.
		yield* TestClock.adjust("10 seconds");
		return yield* Fiber.join(fiber).pipe(Effect.exit);
	});

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

it.effect(
	"withColdStartRetry: a cold `topic:`-DO publish retries the RpcCallError, then LiveTransportError (#2551)",
	() =>
		// A publish to an idle-evicted `topic:` DO fails on the cold first RPC; it must be
		// retried across the bounded window, not dropped bare.
		Effect.gen(function* () {
			let attempts = 0;
			const coldPublish = Effect.suspend(() => {
				attempts += 1;
				return Effect.fail(rpcCallError(new Error("cold topic DO"), "publish"));
			});
			const exit = yield* runPastBackoff(withColdStartRetry("publish", coldPublish));
			assert.strictEqual(attempts, 5, "the bounded retry fired (1 attempt + 4 retries)");
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
	"withColdStartRetryFetch: a cold-DO transport DEFECT (bare Error) → LiveTransportError, not a die (#1048)",
	() =>
		Effect.gen(function* () {
			// workerd rejects an unreachable DO with a bare `Error` ("Network connection
			// lost."), which alchemy's wrapper turns into a defect. See ADR 0095.
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.die(new Error("cold-do unreachable"))),
			);
			assert.isTrue(Exit.isFailure(exit));
			const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
			assert.isFalse(
				reasons.some(Cause.isDieReason),
				"the transport defect was lifted to a failure, not left as a die",
			);
			assert.instanceOf(failureValue(exit), LiveTransportError);
		}),
);

it.effect(
	"withColdStartRetryFetch: a non-transport code DEFECT (marshaling SyntaxError) RE-RAISES, not masked (#1367)",
	() =>
		Effect.gen(function* () {
			// A marshaling die is not a cold-start signal. The blanket `catchDefect` used to
			// launder it into a retried 503 — the ADR 0095 lie, inverted.
			const marshalingDie = new SyntaxError("Unexpected token in response body");
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.die(marshalingDie)),
			);
			assert.isTrue(Exit.isFailure(exit));
			const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
			assert.isTrue(
				reasons.some(Cause.isDieReason),
				"the non-transport defect stays a die (fail-fast 500), never lifted to a retried failure",
			);
			assert.isUndefined(failureValue(exit), "no typed LiveTransportError failure was produced");
			const die = reasons.find(Cause.isDieReason);
			assert.strictEqual(die?.defect, marshalingDie, "the original defect propagates unchanged");
		}),
);

it.effect(
	"withColdStartRetryFetch: a declared HttpServerError-shaped E passes through unconverted",
	() =>
		Effect.gen(function* () {
			// The framing channel stays its own, so the route can `orDie` a real framing
			// defect instead of masking it as a warmup 503.
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.fail(new AppError("framing"))),
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.instanceOf(failureValue(exit), AppError);
		}),
);

it.effect(
	"withColdStartRetryFetch: a transport DEFECT against alchemy's grounded RpcCallError shape → LiveTransportError (#1367)",
	() =>
		Effect.gen(function* () {
			// Proves the discriminant matches alchemy's true field set, not a truncated copy.
			const exit = yield* runPastBackoff(
				withColdStartRetryFetch("open", Effect.die(rpcCallError(new Error("cold")))),
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.instanceOf(failureValue(exit), LiveTransportError);
		}),
);

it.effect("withColdStartRetryFetch: success passes straight through", () =>
	Effect.gen(function* () {
		const exit = yield* runPastBackoff(withColdStartRetryFetch("open", Effect.succeed("ok")));
		assert.deepStrictEqual(exit, Exit.succeed("ok"));
	}),
);

it("isNonTransportDefect: V8 code-defect classes are re-raised (true)", () => {
	assert.isTrue(isNonTransportDefect(new RangeError("stack overflow")));
	assert.isTrue(isNonTransportDefect(new ReferenceError("x is not defined")));
	assert.isTrue(isNonTransportDefect(new SyntaxError("Unexpected token")));
	assert.isTrue(isNonTransportDefect(new EvalError("eval")));
	assert.isTrue(isNonTransportDefect(new URIError("malformed URI")));
});

it("isNonTransportDefect: cold-DO transport-shaped defects are retried (false)", () => {
	// A bare `Error` is how workerd surfaces a DO transport failure, so it must stay in
	// the retried bucket for the ADR 0095 cold-start path to fire.
	assert.isFalse(isNonTransportDefect(new Error("Network connection lost.")));
	// `TypeError` is the documented residual: ambiguous between a marshaling bug and a
	// network failure, so it is excluded from re-raise. See the predicate's docblock.
	assert.isFalse(isNonTransportDefect(new TypeError("Cannot read properties of undefined")));
	assert.isFalse(isNonTransportDefect(rpcCallError(new Error("cold"))));
	assert.isFalse(isNonTransportDefect("opaque string rejection"));
	assert.isFalse(isNonTransportDefect(undefined));
});
