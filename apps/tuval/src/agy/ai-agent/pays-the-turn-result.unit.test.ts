/**
 * The per-turn `result` this layer owes, over its real event path (#8724).
 *
 * A layer pays it by wrapping its own `events` in `withTurnResult`, and nothing in the type system
 * makes it — so this drives a whole agy turn through the layer and asserts the event landed, once,
 * ahead of the `ready` that closes the turn. Drop the wrap in `AgyAiAgent.ts` and this reds.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Queue, Stream} from "effect";
import type {AgentEvent} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {agyChildStub, agyLayerOver} from "./child-stub.ts";
import {init, responseDone, resultSuccess, userInput} from "./fixtures.ts";

const CWD = "/tuval/agy-turn-result";

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";

/** Every event up to and including the first one `found` accepts, bounded so a miss names itself. */
const collectTo = (
	events: Queue.Dequeue<AgentEvent, unknown>,
	what: string,
	found: (event: AgentEvent) => boolean,
) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("5 seconds"));
			if (Option.isNone(next)) {
				assert.fail(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`);
			}
			seen.push(next.value);
			if (found(next.value)) return seen;
		}
	});

describe("an agy turn's result", () => {
	it.live("lands once, ahead of the ready that ends the turn, carrying the reply", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("count the files");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* child.say(userInput);
				yield* child.say(responseDone);
				yield* child.say(resultSuccess);

				const turn = yield* collectTo(events, "the turn's own end", isReady);
				const results = turn.filter((event) => event.kind === "result");
				assert.lengthOf(results, 1, "the layer owes exactly one result per finished turn");
				assert.strictEqual(
					turn.indexOf(results[0]!) + 1,
					turn.length - 1,
					"the result must ride immediately ahead of the phase that closes the turn",
				);
				const answer = results[0]!.result;
				assert.isTrue(answer.ok);
				assert.include(answer.text, "Total count: **5**");
				assert.isNotEmpty(answer.items);
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);

	// Nothing said yet is not a turn: the open narrates its own `ready` on this same stream, and an
	// answer published there would be one no operator asked for.
	it.live("says nothing for the open's own ready", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				const opening = yield* collectTo(events, "the opened session's ready", isReady);
				assert.isEmpty(opening.filter((event) => event.kind === "result"));
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);
});
