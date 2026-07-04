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
	isNonTransportDefect,
	LiveTransportError,
	withColdStartRetry,
	withColdStartRetryFetch,
} from "./cold-start-retry.ts";

/**
 * Alchemy's real emitted `RpcCallError` shape, GROUNDED against the dep source:
 * `RpcCallError = Data.TaggedError("RpcCallError")<{method, cause}>`
 * (`alchemy/Cloudflare/Workers/Rpc.ts`), raised by `makeRpcStub`'s `tryPromise`
 * catch as `new RpcCallError({method, cause})`. The fixture carries the FULL field
 * set — `_tag` + `method` + `cause` — not just `{_tag, cause}`, so this pins the
 * coupling against alchemy's true contract (#1367 facet 2). The class is unexported,
 * so this is the closest pin available; keep it in sync with the cited `Rpc.ts`.
 */
const rpcCallError = (cause: unknown, method = "open") => ({
	_tag: "RpcCallError" as const,
	method,
	cause,
});

/** A non-transport app error — a declared `E` that must NOT be retried/converted. */
class AppError {
	readonly _tag = "AppError";
	readonly detail: string;
	constructor(detail: string) {
		this.detail = detail;
	}
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
	"withColdStartRetryFetch: a cold-DO transport DEFECT (bare Error) → LiveTransportError, not a die (#1048)",
	() =>
		Effect.gen(function* () {
			// The cold-DO rejection surfaces as a DEFECT carrying a plain `Error` (alchemy's
			// `Effect.promise`-wrapped fetcher; workerd rejects an unreachable DO with a bare
			// `Error`, e.g. "Network connection lost."). It must land as a typed FAILURE
			// (→ 503), never a defect at the boundary — the ADR 0095 behavior preserved.
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
			// A marshaling/`Effect.map` die — here a `SyntaxError`, as a JSON parse failure
			// while rendering the DO response — is NOT a cold-start signal. The blanket
			// `catchDefect` used to launder it into a retried 503 (the ADR 0095 lie,
			// inverted); it must now propagate as a DIE (500-class), never a LiveTransportError.
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

it.effect(
	"withColdStartRetryFetch: a transport DEFECT against alchemy's grounded RpcCallError shape → LiveTransportError (#1367)",
	() =>
		Effect.gen(function* () {
			// Pin the coupling: a defect whose value is alchemy's REAL emitted shape
			// (`{_tag:"RpcCallError", method, cause}`, grounded in `Rpc.ts`) must fire the
			// retry → 503 path, proving the discriminant matches the true field set, not a
			// truncated copy.
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

// isNonTransportDefect — the conservative `.fetch` defect discriminant (#1367), both
// arms: a code defect re-raises (true); an opaque/transport-shaped defect retries as the
// cold-DO signal (false). The asymmetry IS the residual — see the predicate docblock for
// why `TypeError`/bare-`Error` stay in the retried bucket.

it("isNonTransportDefect: V8 code-defect classes are re-raised (true)", () => {
	assert.isTrue(isNonTransportDefect(new RangeError("stack overflow")));
	assert.isTrue(isNonTransportDefect(new ReferenceError("x is not defined")));
	assert.isTrue(isNonTransportDefect(new SyntaxError("Unexpected token")));
	assert.isTrue(isNonTransportDefect(new EvalError("eval")));
	assert.isTrue(isNonTransportDefect(new URIError("malformed URI")));
});

it("isNonTransportDefect: cold-DO transport-shaped defects are retried (false)", () => {
	// A bare `Error` is how workerd surfaces a DO transport/readiness failure — it must
	// stay in the retried bucket so the ADR 0095 cold-start path still fires.
	assert.isFalse(isNonTransportDefect(new Error("Network connection lost.")));
	// `TypeError` is the documented residual: ambiguous (marshaling bug OR network), so
	// excluded from re-raise to protect AC3 — see the predicate docblock.
	assert.isFalse(isNonTransportDefect(new TypeError("Cannot read properties of undefined")));
	// alchemy's structural `RpcCallError` value and non-Error rejections are not code
	// defects either.
	assert.isFalse(isNonTransportDefect(rpcCallError(new Error("cold"))));
	assert.isFalse(isNonTransportDefect("opaque string rejection"));
	assert.isFalse(isNonTransportDefect(undefined));
});
