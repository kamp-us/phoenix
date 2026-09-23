/**
 * The agy row has no effort axis, over the layer's real event path (#9254).
 *
 * agy bakes reasoning effort into the model id, so `--effort` is accepted only when it repeats the
 * suffix already in `--model` and refused outright for a model carrying none. Two facts follow from
 * that and are asserted separately: the thinking catalog the layer publishes is the resolved-empty
 * offer on the open and on a respawn alike, and every `ThinkingLevel` is refused with an empty
 * `available` while the running child is left alone — which is the half the integration tier cannot
 * state as cheaply, because it has to be read as a launch count across a call that spawns nothing.
 *
 * Limits of the proof: the spawner is a stub, so no real `agy` judges the argv. The scripted binary
 * beside this file (`agy-ai-agent.integration.test.ts`) drives the same path over real spawns.
 */

import {assert, describe, it} from "@effect/vitest";
import {Mode, thinkingLevels} from "@kampus/tuval-sdk/ai-agent/ports";
import type {AgentEvent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {TuvalAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {Effect, Fiber, Option, Queue, Stream} from "effect";
import {agyChildrenStub, agyLayerOver, type StubChild} from "./child-stub.ts";
import {init} from "./fixtures.ts";

const CWD = "/tuval/agy-thinking";

/**
 * What every wait here is bounded by, strictly under the 5000ms per-test budget so a starved wait
 * reaches its own message rather than vitest's bare timeout (#8940).
 */
const INNER_BOUND = "2 seconds";

type ThinkingOffer = Extract<AgentEvent, {kind: "thinking"}>;

/**
 * One opened session, with a subscription taken across the open itself.
 *
 * The subscription is taken *after* the first launch and before the `init` that completes it, which
 * is the one window that catches the open's own announce: `start` shuts the queue it was called on
 * down and installs a fresh one before it launches, so a subscription taken earlier is reading a
 * queue that is about to end, and one taken after the join has missed the announce.
 */
const openedWatching = (children: {
	readonly child: (index: number) => Effect.Effect<StubChild>;
	readonly launches: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>;
}) =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		const starting = yield* Effect.forkChild(agent.start({cwd: CWD}));
		const first = yield* children.child(0);
		const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
		yield* first.say(init);
		yield* Fiber.join(starting);
		return {agent, events};
	});

/** Every thinking offer up to the nth, bounded so a miss names what it saw. */
const offersTo = (
	events: Queue.Dequeue<AgentEvent, unknown>,
	wanted: number,
): Effect.Effect<ReadonlyArray<ThinkingOffer>> =>
	Effect.gen(function* () {
		const seen: Array<ThinkingOffer> = [];
		while (seen.length < wanted) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption(INNER_BOUND));
			if (Option.isNone(next)) {
				assert.fail(`timed out waiting for ${wanted} thinking offers; saw ${seen.length}`);
			}
			if (next.value.kind === "thinking") seen.push(next.value);
		}
		return seen;
	});

describe("the agy row's thinking offer", () => {
	it.live("is the resolved-empty offer on the open and on a respawn alike", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const {agent, events} = yield* openedWatching(children);

				// A mode switch is a respawn, and a respawn announces the three catalogs again: its
				// offer is the one a picker would be re-populated from.
				const switching = yield* Effect.forkChild(agent.setMode(Mode.make("plan")));
				yield* Effect.flatMap(children.child(1), (child) => child.say(init));
				yield* Fiber.join(switching);

				const offers = yield* offersTo(events, 2);
				assert.deepStrictEqual(
					offers.map((offer) => ({current: offer.current, available: [...offer.available]})),
					[
						{current: null, available: []},
						{current: null, available: []},
					],
					"an offer carried a current level or a level to pick",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	it.live("refuses every level with an empty available, and leaves the child alone", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const {agent} = yield* openedWatching(children);
				const before = yield* children.launches;

				const refusals = yield* Effect.forEach(
					thinkingLevels,
					(level) => Effect.flip(agent.setThinkingLevel(level)),
					{concurrency: 1},
				);

				assert.deepStrictEqual(
					refusals.map((refusal) => refusal._tag),
					thinkingLevels.map(() => "tuval/ai-agent/ThinkingUnsupported"),
					"a level was accepted rather than refused",
				);
				assert.deepStrictEqual(
					refusals.map((refusal) => [...refusal.available]),
					thinkingLevels.map(() => []),
					"a refusal offered a level to pick instead",
				);
				assert.deepStrictEqual(
					refusals.map((refusal) => refusal.level),
					[...thinkingLevels],
					"a refusal named a level other than the one asked for",
				);
				// The child is untouched: a respawn would have launched a second one, and the level
				// asked for would have ridden it as `--effort`.
				assert.deepStrictEqual(
					yield* children.launches,
					before,
					"a refused thinking switch respawned the child",
				);
				assert.deepStrictEqual(
					yield* Effect.flatMap(children.child(0), (child) => child.signals),
					[],
					"a refused thinking switch signalled the running child",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);
});
