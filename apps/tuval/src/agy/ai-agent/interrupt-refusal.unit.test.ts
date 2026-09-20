/**
 * An agy `SIGINT` the platform would not deliver, over the layer's real event path (ADR 0356).
 *
 * The same contract the three peer adapters owe, proved separately because agy answers it from a
 * third place: the refusal is a failed `kill` rather than a refused control request, and `reason`
 * comes off this layer's own memory of having sent a turn — agy's wire says nothing about the turn
 * at all, which is the measurement ADR 0362 records. A layer that read the reason wrong would send
 * the fold to the other arm and walk a running turn to `ready`.
 *
 * Limits of the proof: the spawner is a stub, so what runs is the mapping from a refused `kill` to
 * the event the core folds — not a real SIGINT, and not the conditions under which the operating
 * system refuses to deliver one. A live child never refuses a signal on demand, which is why the
 * subprocess is the part that is faked here and the layer is not.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Queue, Stream} from "effect";
import type {AgentEvent} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {agyChildStub, agyLayerOver} from "./child-stub.ts";
import {init, responseDone, resultSuccess, userInput} from "./fixtures.ts";

const CWD = "/tuval/agy-interrupt-refusal";

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

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isFailure = (event: AgentEvent): boolean => event.kind === "failure";

const failureOf = (events: ReadonlyArray<AgentEvent>) => {
	const one = events.at(-1);
	assert.isTrue(one?.kind === "failure", "the last event collected is not the refusal");
	return (one as Extract<AgentEvent, {kind: "failure"}>).failure;
};

describe("an agy SIGINT the child would not take", () => {
	it.live("reaches the core as its own failure tag rather than a log line", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;

				const failure = failureOf(yield* collectTo(events, "the refused signal", isFailure));
				assert.strictEqual(
					yield* child.kills,
					1,
					"the layer reported a refusal it never asked for",
				);
				assert.strictEqual(failure.tag, "tuval/ai-agent/InterruptError");
				assert.strictEqual(failure.reason, "turn-running");
				assert.include(failure.detail, "agy refused to interrupt the turn");
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);

	// A refusal is not a turn ending: nothing the layer emits for it may read as one, because the
	// phase is what the window's stop control and its Escape branch key on.
	it.live("narrates no phase change of its own", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);
				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;

				const after = yield* collectTo(events, "the refused signal", isFailure);
				assert.isEmpty(
					after.filter((event) => event.kind === "phase"),
					"the refusal narrated a phase the backend never entered",
				);
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);

	// The relaunch guard is armed from the signal rather than from the child's exit (#8925), so the
	// refusal arm has to give it back the way it gives the claim back: a backend that said no leaves
	// the child alive, and a guard held past that locks sends out for the life of the layer.
	it.live("leaves the next send free: a refused signal is not a relaunch", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);
				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;
				yield* collectTo(events, "the refused signal", isFailure);

				yield* agent.prompt("say hello again");
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);

	// The other half the fold routes on: the turn's `result` has landed, so there was nothing left
	// to stop and the session is owed its way back to `ready`.
	it.live("says there was no live turn once the result has landed", () =>
		Effect.gen(function* () {
			const child = yield* agyChildStub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);
				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* child.say(userInput);
				yield* child.say(responseDone);
				yield* child.say(resultSuccess);
				yield* collectTo(events, "the turn's own end", isReady);
				yield* agent.interrupt;

				const failure = failureOf(yield* collectTo(events, "the refused signal", isFailure));
				assert.strictEqual(failure.reason, "no-live-turn");
			}).pipe(Effect.provide(agyLayerOver(child)), Effect.scoped);
		}),
	);
});
