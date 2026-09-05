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

/**
 * `assistant-turn.json` is init, one assistant frame and one `success` result — four events out:
 * the model init names, the reply, the turn's spend, and the `ready` that ends it.
 */
const ASSISTANT_TURN_EVENTS = 4;

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
	it.effect("emits exactly one ready, after the result and nowhere before it", () =>
		Effect.gen(function* () {
			const events = yield* promptedTurn(messages("assistant-turn"), ASSISTANT_TURN_EVENTS);
			assert.deepStrictEqual(
				events.map((event) => event.kind),
				["usage", "item", "usage", "phase"],
			);
			assert.deepStrictEqual(
				events.filter((event) => event.kind === "phase"),
				[{kind: "phase", phase: "ready"}],
			);
		}),
	);

	it.effect("ends a failing turn the same way, so no error subtype wedges the session", () =>
		Effect.gen(function* () {
			// `error_max_turns`, one of `SDKResultError`'s four subtypes: a system line for the
			// failure, then the same `ready` a success carries.
			const events = yield* promptedTurn([message("error-result")], 2);
			assert.deepStrictEqual(
				events.map((event) => event.kind),
				["item", "phase"],
			);
			assert.deepStrictEqual(events[1], {kind: "phase", phase: "ready"});
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
