/**
 * Where a Claude turn begins and ends, as the layer narrates it (#7963).
 *
 * `SDKResultMessage` is "the outcome of a turn … treat it as the turn-complete signal"
 * (`sdk.d.ts` at the `0.3.259` pin `sdk.ts` records), and `SDKSystemMessage`/`init` is "session
 * metadata the CLI emits at the start of each turn" — so `result` is the turn's end and `init` is
 * not. Every case replays a golden fixture through the scripted SDK, so nothing calls a model
 * (`../history/fixtures/PROVENANCE.md`).
 *
 * The last two fold what the layer emitted through the real core, because the phase's whole job is
 * the `prompt` guard in `../../ai-agent/core/machine.ts`: a stream that reads right and still leaves
 * the core refusing prompts has proved nothing.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {applyCellChecked} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {CWD, message, messages, on, SESSION_ID, START_EVENTS} from "./fixtures/harness.ts";

/**
 * Start, let the open's own three events go by, prompt, and collect the turn that answers.
 *
 * `deferOpening` withholds every frame until the prompt lands, which is the real CLI's shape and
 * the one that puts `init` inside the turn rather than ahead of it.
 */
const promptedTurn = (opening: ReadonlyArray<SDKMessage>, count: number) =>
	on({opening, deferOpening: true}, (agent) =>
		Effect.gen(function* () {
			yield* agent.start({cwd: CWD});
			yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
			yield* agent.prompt("hello");
			return [...(yield* Stream.runCollect(Stream.take(agent.events, count)))];
		}),
	);

/** Everything the open alone puts on the queue, in order, before any prompt. */
const openingEvents = (opening: ReadonlyArray<SDKMessage>) =>
	on({opening, deferOpening: true}, (agent) =>
		Effect.gen(function* () {
			yield* agent.start({cwd: CWD});
			return [...(yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS)))];
		}),
	);

/** What the open alone puts on the queue, before any prompt — the `ready` #8107 is about. */
const openingOf = (opening: ReadonlyArray<SDKMessage>) =>
	Effect.map(openingEvents(opening), (events) =>
		events.filter((event) => event.kind === "phase" && event.phase === "ready"),
	);

/**
 * `assistant-turn.json` is init, one assistant frame and one `success` result — six events out: the
 * `prompting` the send itself narrates, the model and the CLI version init names, the reply, the
 * turn's spend, and the `ready` that ends it.
 */
const ASSISTANT_TURN_EVENTS = 6;

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const opened: AiAgentSessionState = {...initialState(CWD), phase: "ready", sessionId: SESSION_ID};

const SENT_AT = 1_700_000_000_000;

const fold = (state: AiAgentSessionState, events: ReadonlyArray<AgentEvent>): AiAgentSessionState =>
	events.reduce(
		(carried, event) => apply(carried, {type: "event", sessionId: SESSION_ID, event})[0],
		state,
	);

describe("a turn ends on its result", () => {
	/**
	 * The pair is what the core reads, not either half (#8107): a send is accepted on the end of a
	 * turn the layer said had begun, so `prompting` leads the turn and exactly one `ready` closes
	 * it. `prompting` is published before the write, so nothing the pump pushes can precede it.
	 */
	it.effect("brackets the turn: prompting at the send, one ready at the result", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			assert.deepStrictEqual(
				events.map((event) => event.kind),
				["phase", "usage", "version", "item", "usage", "phase"],
			);
			assert.deepStrictEqual(
				events.filter((event) => event.kind === "phase"),
				[
					{kind: "phase", phase: "prompting"},
					{kind: "phase", phase: "ready"},
				],
			);
		}),
	);

	it.effect("ends a failing turn the same way, so no error subtype wedges the session", () =>
		Effect.gen(function* () {
			// `error_max_turns`, one of `SDKResultError`'s four subtypes: the send's own
			// `prompting`, a system line for the failure, then the same `ready` a success carries.
			const events = yield* promptedTurn([message("error-result")], 3);
			assert.deepStrictEqual(
				events.map((event) => event.kind),
				["phase", "item", "phase"],
			);
			assert.deepStrictEqual(events[0], {kind: "phase", phase: "prompting"});
			assert.deepStrictEqual(events[2], {kind: "phase", phase: "ready"});
		}),
	);
});

/**
 * Claude's half of #8007, on the path where the CLI takes the abort: the confirming event is the
 * turn's own `result`, which the pump emits `ready` for on every subtype including the errors an
 * aborted turn ends on. A refused one is a failure event of its own and reads in
 * `interrupt-refusal.unit.test.ts` (ADR 0356).
 */
describe("an interruption over the Claude event path", () => {
	const asked = (
		events: ReadonlyArray<AgentEvent>,
	): {readonly state: AiAgentSessionState; readonly turn: ReadonlyArray<AgentEvent>} => {
		const [prompting] = apply(opened, {
			type: "prompt",
			text: "hello",
			key: "k1",
			timestamp: SENT_AT,
		});
		// Every event but the turn's own end, so the abort is asked for mid-turn.
		const running = fold(prompting, events.slice(0, -1));
		const [state] = apply(running, {type: "interrupt", at: SENT_AT + 1});
		return {state, turn: events};
	};

	it.effect("stays busy with the request outstanding until the result lands", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			const {state} = asked(events);
			assert.strictEqual(state.phase, "prompting");
			assert.deepStrictEqual(state.interruption, {requestedAt: SENT_AT + 1});
		}),
	);

	it.effect("comes back to ready on the turn's result and clears the request", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			const {state, turn} = asked(events);
			const settled = fold(state, turn.slice(-1));
			assert.strictEqual(settled.phase, "ready");
			assert.isNull(settled.interruption);
		}),
	);

	// The shape an aborted turn actually ends on: an error subtype rather than a success.
	it.effect("settles on an error-subtype result exactly as it settles on a success", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn([message("error-result")], 3);
			const {state, turn} = asked(events);
			assert.strictEqual(state.phase, "prompting");
			const settled = fold(state, turn.slice(-1));
			assert.strictEqual(settled.phase, "ready");
			assert.isNull(settled.interruption);
		}),
	);
});

describe("the core over what the layer emitted", () => {
	// `prompting` is the whole claim the window's stop control and its Escape branch read:
	// `isWorking` is `phase === "prompting"`, and that it is true of that phase alone is pinned in
	// `../../shell/chat/phase.unit.test.ts`. It is not called here because the browser chat slice is
	// excluded from this project's lens (`apps/tuval/tsconfig.json`).
	it.effect("keeps the session prompting for the whole turn, so the window reads working", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			const [prompting] = apply(opened, {
				type: "prompt",
				text: "hello",
				key: "k1",
				timestamp: SENT_AT,
			});
			// Every event but the last, which is the turn's own end.
			const running = fold(prompting, events.slice(0, -1));
			assert.strictEqual(running.phase, "prompting");
		}),
	);

	/**
	 * #8107 from the layer's side. A turn this layer really ran accepts its send, and the `ready`
	 * this session emitted at its own open — replayed out of the queue under a live send — does
	 * not, so the window keeps the copy it is holding.
	 */
	it.effect("accepts the send on a turn it ran, and not on the open's own ready", () =>
		Effect.gen(function* () {
			const turn = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			const opening = yield* openingOf(messages("assistant-turn"));
			const [sent] = apply(opened, {
				type: "prompt",
				text: "hello",
				key: "k1",
				timestamp: SENT_AT,
			});
			assert.deepStrictEqual(fold(sent, turn).sends, [{key: "k1", state: "accepted"}]);
			assert.deepStrictEqual(fold(sent, opening).sends, [
				{key: "k1", state: "pending", turn: "unstarted"},
			]);
		}),
	);

	it.effect("admits a second prompt once the turn's result has landed", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			const [prompting] = apply(opened, {
				type: "prompt",
				text: "hello",
				key: "k1",
				timestamp: SENT_AT,
			});
			const settled = fold(prompting, events);
			assert.strictEqual(settled.phase, "ready");
			const [next, cmds] = apply(settled, {
				type: "prompt",
				text: "and again",
				key: "k2",
				timestamp: SENT_AT,
			});
			assert.isNull(next.failure);
			assert.deepStrictEqual(cmds, [{type: "aiAgent.prompt", text: "and again", key: "k2"}]);
		}),
	);
});

/**
 * The first turn of a session the picker has just opened (#8358).
 *
 * The open's own events sit in the layer's queue until the core's `started` commit opens the events
 * Sub (`../../ai-agent/core/machine.ts`, `subscriptions`), so a prompt admitted in that window is
 * folded ahead of them: `admit` walks the session to `prompting` and the open's own `ready` lands on
 * top of it. That is the order the operator measured on PR #8199's head — a 30 s turn narrated
 * `Ready.`, with no `Working…` and no Escape affordance.
 *
 * What closes it is the `prompting` the send itself narrates (#8156, `prompt` in
 * `./ClaudeAiAgent.ts`). It sits behind the open's events on the one queue, so the session is back
 * on `prompting` before the turn's first frame and stays there until the `result`.
 */
describe("a first turn whose open drained after the send", () => {
	const sent = (): AiAgentSessionState =>
		apply(opened, {type: "prompt", text: "hello", key: "k1", timestamp: SENT_AT})[0];

	it.effect("narrates prompting for the whole turn, and ready only at its end", () =>
		Effect.gen(function* () {
			const opening = yield* openingEvents(messages("assistant-turn"));
			const turn = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);

			const late = fold(sent(), opening);
			assert.strictEqual(late.phase, "ready", "the open's ready is what walks the send back");
			assert.deepStrictEqual(
				late.sends,
				[{key: "k1", state: "pending", turn: "unstarted"}],
				"the open's ready must not accept a send whose turn never began (#8107)",
			);

			const running = fold(late, turn.slice(0, -1));
			assert.strictEqual(running.phase, "prompting");
			assert.deepStrictEqual(running.sends, [{key: "k1", state: "pending", turn: "running"}]);

			const settled = fold(running, turn.slice(-1));
			assert.strictEqual(settled.phase, "ready");
			assert.deepStrictEqual(settled.sends, [{key: "k1", state: "accepted"}]);
		}),
	);

	/**
	 * Why that narration is load-bearing rather than decoration. Drop the one event the send
	 * publishes and the same fold leaves a running turn reading idle for its whole length — the
	 * defect itself, pinned here so a layer that stops narrating its own send reds the case above
	 * rather than shipping a `Ready.` line over a live turn.
	 */
	it.effect("would read idle for the whole turn without the send's own prompting", () =>
		Effect.gen(function* () {
			const opening = yield* openingEvents(messages("assistant-turn"));
			const turn = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			assert.deepStrictEqual(turn[0], {kind: "phase", phase: "prompting"});

			const unnarrated = fold(fold(sent(), opening), turn.slice(1, -1));
			assert.strictEqual(unnarrated.phase, "ready");
			assert.deepStrictEqual(unnarrated.sends, [{key: "k1", state: "pending", turn: "unstarted"}]);
		}),
	);
});
