import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Option, Stream} from "effect";
import {makeTrustPrompts, type TrustPrompts} from "./TrustPrompts.ts";
import type {TrustPrompt} from "./trust-prompt.ts";

/** The first non-empty list of waiting questions: the ask runs on a fiber of its own. */
const firstPending = (prompts: TrustPrompts["Service"]) =>
	prompts.pending.pipe(
		Stream.filter((pending) => pending.length > 0),
		Stream.runHead,
		Effect.map(Option.getOrElse((): ReadonlyArray<TrustPrompt> => [])),
	);

const pendingNow = (prompts: TrustPrompts["Service"]) =>
	Effect.map(Stream.runHead(prompts.pending), Option.getOrNull);

describe("TrustPrompts", () => {
	it.effect("shows a question while an open waits, and hands it the page's answer", () =>
		Effect.gen(function* () {
			const prompts = yield* makeTrustPrompts;
			const waiting = yield* Effect.forkChild(prompts.ask("/work/phoenix"));
			const [prompt] = yield* firstPending(prompts);
			assert.strictEqual(prompt?.folder, "/work/phoenix");
			assert.strictEqual(prompt?.name, "phoenix");
			assert.isTrue(yield* prompts.answer(prompt?.question ?? "", "trust"));
			assert.strictEqual(yield* Fiber.join(waiting), "trust");
			assert.deepStrictEqual(yield* pendingNow(prompts), []);
		}),
	);

	it.effect("answers a question once: a second page's answer finds nothing waiting", () =>
		Effect.gen(function* () {
			const prompts = yield* makeTrustPrompts;
			const waiting = yield* Effect.forkChild(prompts.ask("/work/a"));
			const [prompt] = yield* firstPending(prompts);
			const question = prompt?.question ?? "";
			assert.isTrue(yield* prompts.answer(question, "refuse"));
			assert.strictEqual(yield* Fiber.join(waiting), "refuse");
			assert.isFalse(yield* prompts.answer(question, "trust"));
		}),
	);

	it.effect("takes a question back off the pages when the open waiting on it is interrupted", () =>
		Effect.gen(function* () {
			const prompts = yield* makeTrustPrompts;
			const waiting = yield* Effect.forkChild(prompts.ask("/work/a"));
			const [prompt] = yield* firstPending(prompts);
			yield* Fiber.interrupt(waiting);
			assert.deepStrictEqual(yield* pendingNow(prompts), []);
			assert.isFalse(yield* prompts.answer(prompt?.question ?? "", "trust"));
		}),
	);
});
