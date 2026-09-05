/**
 * The operator's own turn, from the send to whatever the layer does about it (#7978).
 *
 * The events are the ones `ScriptedAiAgent` actually queues, collected before any of them is
 * folded, so the two halves the fix has to hold are separable here in a way they are not in a
 * running process: what the transcript says the moment the `prompt` Msg lands, and what it says
 * once the turn's events have gone through `update`.
 *
 * Two backends, one core rule. `plainReply` echoes the user turn back under its own id, which is
 * Pi's shape; `noEchoReply` never mentions it, which is Claude's.
 */

import {applyCellChecked} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
	promptItemId,
} from "./core/index.ts";
import type {AgentEvent} from "./events.ts";
import type {TranscriptItem, UserItem} from "./ports/index.ts";
import {
	noEchoReply,
	noEchoReplyTurn,
	plainReply,
	plainReplyTurn,
	SESSION_ID,
} from "./service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent, TuvalAiAgent} from "./service/index.ts";

const CWD = "/work";
const SENT_AT = 1_700_000_000_000;

/** `start` queues three events before any turn: starting, the mode list, ready. */
const START_EVENTS = 3;

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const ready: AiAgentSessionState = {...initialState(CWD), phase: "ready", sessionId: SESSION_ID};

/** What one scripted turn puts on the stream, with `start`'s own three dropped. */
const turnEvents = (
	script: AgentScript,
	text: string,
	count: number,
): Effect.Effect<ReadonlyArray<AgentEvent>> =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		yield* agent.start({cwd: CWD}).pipe(Effect.orDie);
		yield* agent.prompt(text, "k1").pipe(Effect.orDie);
		const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + count)).pipe(
			Effect.orDie,
		);
		return events.slice(START_EVENTS);
	}).pipe(Effect.provide(ScriptedAiAgent.layer(script)), Effect.scoped);

const foldAll = (
	state: AiAgentSessionState,
	events: ReadonlyArray<AgentEvent>,
): AiAgentSessionState =>
	events.reduce(
		(carried, event) => apply(carried, {type: "event", sessionId: SESSION_ID, event})[0],
		state,
	);

const usersIn = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<UserItem> =>
	items.filter((item): item is UserItem => item.kind === "user");

const send = (text: string): AiAgentSessionMsg => ({
	type: "prompt",
	text,
	key: "k1",
	timestamp: SENT_AT,
});

describe("a backend that echoes the operator's turn", () => {
	it.effect("shows the send at once, then keeps it exactly once under the layer's id", () =>
		Effect.gen(function* () {
			const events = yield* turnEvents(plainReply, "hello", plainReplyTurn.length);
			const echo = events[1];
			assert.strictEqual(echo?.kind === "item" ? echo.item.kind : null, "user");

			const [sent] = apply(ready, send("hello"));
			assert.deepStrictEqual(
				usersIn(sent.transcript.items).map((item) => [item.id, item.text, item.local]),
				[[promptItemId("k1"), "hello", true]],
			);

			const settled = foldAll(sent, events);
			assert.deepStrictEqual(
				usersIn(settled.transcript.items).map((item) => [item.id, item.text, item.local]),
				[["u1", "hello", undefined]],
			);
			assert.deepStrictEqual(
				settled.transcript.items.map((item) => item.id),
				["u1", "a1"],
			);
		}),
	);
});

describe("a backend that never echoes it", () => {
	it.effect("leaves the recorded turn standing, shown exactly once", () =>
		Effect.gen(function* () {
			const events = yield* turnEvents(noEchoReply, "hello", noEchoReplyTurn.length);
			const [sent] = apply(ready, send("hello"));
			const settled = foldAll(sent, events);

			assert.deepStrictEqual(
				usersIn(settled.transcript.items).map((item) => [item.id, item.text]),
				[[promptItemId("k1"), "hello"]],
			);
			assert.deepStrictEqual(
				settled.transcript.items.map((item) => item.id),
				[promptItemId("k1"), "a4"],
			);
		}),
	);
});
