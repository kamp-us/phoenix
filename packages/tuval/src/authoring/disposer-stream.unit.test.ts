import {type Sub, subIdOf} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Scope, Stream} from "effect";
import {disposerStream} from "./disposer-stream.ts";

type Ticker = Sub<"ticker", true>;

describe("disposerStream", () => {
	it.effect("holds the Stream open until it is interrupted, then runs the dispose", () =>
		Effect.gen(function* () {
			const log: string[] = [];
			const runner = disposerStream<Ticker, never>(() => {
				log.push("open");
				return () => void log.push("dispose");
			});
			const sub: Ticker = {id: subIdOf("ticker", true), type: "ticker", deps: true};
			const scope = yield* Scope.make();
			const fiber = yield* Effect.forkIn(Stream.runDrain(runner(sub)), scope, {
				startImmediately: true,
			});
			yield* Effect.yieldNow;

			assert.deepStrictEqual(log, ["open"]);
			assert.isUndefined(fiber.pollUnsafe());
			yield* Scope.close(scope, Exit.void);
			assert.deepStrictEqual(log, ["open", "dispose"]);
		}),
	);
});
