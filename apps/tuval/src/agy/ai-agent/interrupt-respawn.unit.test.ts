/**
 * What an agy stop leaves behind, over the layer's real event path (#8709).
 *
 * A SIGINT agy takes ends the child, so the session the window holds survives only if the layer
 * relaunches it — and the relaunch has to be the one `setModel` already uses, because that is the
 * one that keeps the conversation id and the event queue. Three facts make that true and are
 * asserted separately: the second launch carries `--conversation=<id>`, the phase the window ends on
 * is `ready`, and the stream the window subscribed to is still the same live stream afterwards.
 *
 * Limits of the proof: the spawner is a stub, so the signal is recorded rather than delivered and
 * the exit is the test's. What is real is everything above the pipe — `follow`'s fold, the exit
 * watch's own reading of the stop, and `respawn`. The scripted binary beside this file
 * (`agy-ai-agent.integration.test.ts`) drives the same path over a real SIGINT and a real exit.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Option, Queue, Stream} from "effect";
import type {AgentEvent, StartError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {agyChildrenStub, agyLayerOver, type StubChild} from "./child-stub.ts";
import {init, resultInterrupted, userInput} from "./fixtures.ts";

const CWD = "/tuval/agy-interrupt-respawn";

/** The conversation id the captured `init` line opens, which is what a relaunch has to carry. */
const CONVERSATION = "9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf";

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

/** Waits until the stop has reached the child, so what follows is ordered after the signal. */
const signalled = (child: StubChild): Effect.Effect<void> =>
	Effect.flatMap(child.signals, (seen) =>
		seen.length === 0 ? Effect.andThen(Effect.sleep("5 millis"), signalled(child)) : Effect.void,
	).pipe(
		Effect.timeoutOrElse({
			duration: "5 seconds",
			orElse: () => Effect.die(new Error("the stop sent no signal")),
		}),
	);

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isInterruptedItem = (event: AgentEvent): boolean =>
	event.kind === "item" && event.item.kind === "assistant" && event.item.interrupted === true;

describe("an agy turn the operator stops", () => {
	/**
	 * One opened session over a relaunching stub. `start` awaits `init`, and the child it awaits does
	 * not exist until the launch — so the launch is forked and the line written into the child it
	 * produced.
	 */
	const opened = (children: {
		readonly child: (index: number) => Effect.Effect<StubChild>;
	}): Effect.Effect<void, StartError, TuvalAiAgent> =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			const starting = yield* Effect.forkChild(agent.start({cwd: CWD}));
			yield* Effect.flatMap(children.child(0), (child) => child.say(init));
			yield* Fiber.join(starting);
		});

	it.live("comes back on the same conversation, on the same stream, at ready", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* opened(children);
				// Subscribed after the open, because `start` replaces the queue it opened on: a
				// subscription taken before it is reading a queue `start` shuts down.
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.prompt("something long");
				yield* collectTo(events, "the turn's prompting", isPrompting);

				// The stop, as the wire and the process really order it: the signal lands, agy writes
				// its terminal `result` naming the stop, and only then does the child exit.
				const stopping = yield* Effect.forkChild(agent.interrupt);
				const first = yield* children.child(0);
				yield* signalled(first);
				// An impatient second press, which the core does dispatch: the phase is still
				// `prompting` until the terminal `result` lands. It has nothing left to send, and a
				// second signal would take the first one's relaunch down with the queue.
				yield* agent.interrupt;
				yield* first.say(userInput);
				yield* first.say(resultInterrupted);
				yield* first.exit(1);
				// The relaunch is in flight behind the exit, and it is waiting on its own `init`.
				yield* Effect.flatMap(children.child(1), (child) => child.say(init));
				yield* Fiber.join(stopping);

				const launches = yield* children.launches;
				assert.strictEqual(launches.length, 2, "the stop did not relaunch the child");
				assert.include(launches[1] ?? [], `--conversation=${CONVERSATION}`);
				assert.deepStrictEqual(
					yield* first.signals,
					["SIGINT"],
					"the stop sent something other than one SIGINT",
				);

				// The queue the window subscribed to before the stop is the one still answering: a
				// `gone` or a failed take here is the subscription the relaunch exists to keep.
				const after = yield* collectTo(events, "the session back at ready", isReady);
				assert.isEmpty(
					after.filter((event) => event.kind === "phase" && event.phase === "gone"),
					"the stop narrated a session the layer went on to relaunch",
				);
				assert.isTrue(
					after.some(isInterruptedItem),
					"the cut reply lost its interrupted mark across the relaunch",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	// The other half of the exit watch's reading: an exit nobody asked for is still a transport that
	// is gone, and the window is still owed the `gone` and the failed stream.
	it.live("still reports an exit the layer did not ask for", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* opened(children);
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});

				const first = yield* children.child(0);
				yield* first.exit(1);

				yield* collectTo(
					events,
					"the gone phase",
					(event) => event.kind === "phase" && event.phase === "gone",
				);
				const failed = yield* Effect.result(Queue.take(events));
				assert.isTrue(failed._tag === "Failure", "the dead transport left the stream live");
				assert.strictEqual(
					(yield* children.launches).length,
					1,
					"the layer relaunched a child it never stopped",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);
});
