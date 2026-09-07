/**
 * A Claude abort the CLI would not take, over the layer's real event path (#8007, ADR 0356).
 *
 * `interrupt` declares no error channel, so the refusal has one way out of this layer — the event
 * stream — and this is the test that the way out is taken. Before ADR 0356 it was a log line, and
 * the window went on showing an abort in flight that the backend had already declined.
 *
 * Which of the two reasons it carries is the half only this layer can answer: `interruptFailureOf`
 * reads `TurnState.settled`, so a refusal with the turn still going is `turn-running` and one after
 * its `result` is `no-live-turn`. The fold routes on that field alone, so both run below.
 *
 * Limits of the proof: the SDK is scripted, so what is exercised is the mapping from a rejected
 * `Query.interrupt()` to the event the core folds — not the real CLI's abort timing, and not the
 * conditions under which a real CLI refuses one.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {CWD, messages, on, START_EVENTS} from "./fixtures/harness.ts";

const REFUSAL = new Error("Operation aborted");

/** The captured turn with its `result` withheld, which is a turn the CLI is still running. */
const unfinishedTurn = (): ReadonlyArray<SDKMessage> =>
	messages("assistant-turn").filter((message) => message.type !== "result");

const interruptFailure = (
	events: ReadonlyArray<AgentEvent>,
): Extract<AgentEvent, {kind: "failure"}>["failure"] => {
	const failed = events.filter((event) => event.kind === "failure");
	assert.lengthOf(
		failed,
		1,
		`the refusal did not reach the event stream: ${JSON.stringify(events)}`,
	);
	const one = failed[0];
	assert.isTrue(one?.kind === "failure");
	return (one as Extract<AgentEvent, {kind: "failure"}>).failure;
};

/**
 * Start, let the open's own events go by, prompt, drain what `opening` produced, then ask for the
 * abort the scripted SDK refuses and read the events that follow it.
 */
const refusedInterrupt = (opening: ReadonlyArray<SDKMessage>, turnEvents: number) =>
	on({opening, deferOpening: true, interruptFails: REFUSAL}, (agent, scripted) =>
		Effect.gen(function* () {
			yield* agent.start({cwd: CWD});
			yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
			yield* agent.prompt("hello");
			yield* Stream.runCollect(Stream.take(agent.events, turnEvents));
			yield* agent.interrupt;
			const after = [...(yield* Stream.runCollect(Stream.take(agent.events, 1)))];
			return {after, interrupts: scripted.opened[0]?.record.interrupts ?? 0};
		}),
	);

/** `assistant-turn` minus its `result`: the send's own `prompting`, the model init, the reply. */
const RUNNING_TURN_EVENTS = 3;
/** The whole of it, `result` included — the turn's spend and the `ready` that ends it. */
const FINISHED_TURN_EVENTS = 5;

describe("a Claude interrupt the CLI refuses", () => {
	it.effect("reaches the core as its own failure tag rather than a log line", () =>
		Effect.gen(function* () {
			const {after, interrupts} = yield* refusedInterrupt(unfinishedTurn(), RUNNING_TURN_EVENTS);
			const failure = interruptFailure(after);
			assert.strictEqual(interrupts, 1, "the layer reported a refusal it never asked for");
			assert.strictEqual(failure.tag, "tuval/ai-agent/InterruptError");
			assert.strictEqual(failure.reason, "turn-running");
			assert.include(failure.detail, "did not answer the control request");
		}),
	);

	// A refusal is not a turn ending: nothing the layer emits for it may read as one, because the
	// phase is what the window's stop control and its Escape branch key on.
	it.effect("narrates no phase change of its own", () =>
		Effect.gen(function* () {
			const {after} = yield* refusedInterrupt(unfinishedTurn(), RUNNING_TURN_EVENTS);
			assert.isEmpty(
				after.filter((event) => event.kind === "phase"),
				"the refusal narrated a phase the backend never entered",
			);
		}),
	);

	// The other half the fold routes on: the turn ended while the control request was in flight, so
	// there was nothing left to stop and the session is owed its way back to `ready`.
	it.effect("says there was no live turn once the result has landed", () =>
		Effect.gen(function* () {
			const {after} = yield* refusedInterrupt(messages("assistant-turn"), FINISHED_TURN_EVENTS);
			assert.strictEqual(interruptFailure(after).reason, "no-live-turn");
		}),
	);
});
