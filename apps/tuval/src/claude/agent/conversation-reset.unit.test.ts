/**
 * `/clear` over the whole Claude path: the layer's pump, the events it emits, and the core folding
 * them (#8197).
 *
 * A local command is answered by the CLI itself, so no `result` frame follows it and the pump's
 * turn-end `ready` never fires — the session sat at `prompting` for ever. What does arrive is
 * `conversation_reset`, and every case below drives that frame through a live layer rather than
 * calling the mapper, because the mapper returning the right value proved nothing about the phase.
 *
 * **The reset frame is declaration-derived, not captured.** Forcing one means sending `/clear` to a
 * live CLI, which is an operator run with real credentials and real spend, so no `query()` fixture
 * of it exists (`../history/fixtures/PROVENANCE.md`, "What is not captured"). The frame below is
 * `SDKConversationResetMessage` as `sdk.d.ts` declares it at the `0.3.259` catalog pin — `type`,
 * `new_conversation_id`, `uuid`, `session_id` and nothing else. Every other frame these cases use is
 * a real capture.
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
	restore,
} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {CWD, message, on, SESSION_ID, START_EVENTS} from "./fixtures/harness.ts";

/** The conversation the CLI opens in place of the one `/clear` ended. */
const NEW_CONVERSATION_ID = "00000000-0000-4000-8000-0000000000c1";

const resetFrame = {
	type: "conversation_reset",
	new_conversation_id: NEW_CONVERSATION_ID,
	uuid: "00000000-0000-4000-8000-0000000000c2",
	session_id: SESSION_ID,
} as SDKMessage;

/**
 * The same frame with the one field that carries the answer missing. Declared through the loose
 * record because `SDKConversationResetMessage` requires `new_conversation_id`: a frame that omits it
 * is off the declared shape, which is the case.
 */
const malformed: Record<string, unknown> = {
	type: "conversation_reset",
	uuid: "00000000-0000-4000-8000-0000000000c3",
	session_id: SESSION_ID,
};

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const fold = (state: AiAgentSessionState, events: ReadonlyArray<AgentEvent>): AiAgentSessionState =>
	events.reduce(
		(carried, event) => apply(carried, {type: "event", sessionId: SESSION_ID, event})[0],
		state,
	);

const opened: AiAgentSessionState = {...initialState(CWD), phase: "ready", sessionId: SESSION_ID};

const SENT_AT = 1_700_000_000_000;

const sent = (state: AiAgentSessionState, text: string, key: string): AiAgentSessionState =>
	apply(state, {type: "prompt", text, key, timestamp: SENT_AT})[0];

/** The prompt's own `prompting`, then the reset — the whole answer a local command produces. */
const CLEARED_EVENTS = 2;

/**
 * Send `/clear`, read what the layer put on the stream, then send again so the second prompt's own
 * envelope says which conversation it landed in.
 */
const cleared = (frames: ReadonlyArray<SDKMessage>) =>
	on({opening: frames, deferOpening: true}, (agent, scripted) =>
		Effect.gen(function* () {
			yield* agent.start({cwd: CWD});
			yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
			yield* agent.prompt("/clear", "k1");
			const events = [...(yield* Stream.runCollect(Stream.take(agent.events, CLEARED_EVENTS)))];
			yield* agent.prompt("and now this", "k2");
			// The scripted query reads the input iterable on its own fiber, so the second envelope
			// is written after this one yields.
			yield* Effect.yieldNow;
			return {events, prompts: [...(scripted.opened[0]?.record.prompts ?? [])]};
		}),
	);

describe("a local command that ends its own conversation", () => {
	it.effect("emits the reset in place of the result no local command produces", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			assert.deepStrictEqual(events, [
				{kind: "phase", phase: "prompting"},
				{kind: "session-reset", sessionId: NEW_CONVERSATION_ID},
			]);
		}),
	);

	it.effect("leaves the session usable rather than prompting for ever", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			const settled = fold(sent(opened, "/clear", "k1"), events);
			assert.strictEqual(settled.phase, "ready");
			// The send crossed — the backend ran the command — so its window may drop its copy.
			assert.deepStrictEqual(settled.sends, [{key: "k1", state: "accepted"}]);
			const [, cmds] = apply(settled, {
				type: "prompt",
				text: "and now this",
				key: "k2",
				timestamp: SENT_AT,
			});
			assert.deepStrictEqual(cmds, [{type: "aiAgent.prompt", text: "and now this", key: "k2"}]);
		}),
	);

	it.effect("stamps the next prompt with the new conversation id", () =>
		Effect.gen(function* () {
			const {prompts} = yield* cleared([resetFrame]);
			assert.deepStrictEqual(
				prompts.map((prompt) => prompt.session_id),
				[SESSION_ID, NEW_CONVERSATION_ID],
			);
		}),
	);

	it.effect("re-keys the session, so a checkpoint resumes the new conversation", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			const settled = fold(sent(opened, "/clear", "k1"), events);
			assert.strictEqual(settled.sessionId, NEW_CONVERSATION_ID);
			assert.strictEqual(restore(settled).sessionId, NEW_CONVERSATION_ID);
			// The events Sub is keyed on the session id, so the swap re-opens it against the
			// conversation the layer is now on rather than the one it just ended.
			assert.notDeepEqual(
				machine.subscriptions(settled).map((sub) => sub.id),
				machine.subscriptions(opened).map((sub) => sub.id),
			);
		}),
	);

	/**
	 * The old conversation leaves the live tail because it is not this conversation's. Nothing of it
	 * is deleted: the backend's store still holds it, which is what the session list reads.
	 */
	it.effect("drops the ended conversation's tail and its unanswerable cards", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			const running = fold(sent(opened, "/clear", "k1"), [
				{
					kind: "item",
					item: {kind: "user", id: ItemId.make("u1"), timestamp: SENT_AT, text: "older turn"},
				},
				{
					kind: "permission",
					request: "req-1",
					detail: {
						title: "Bash",
						displayName: "Bash",
						description: "echo hi",
						input: {command: "echo hi"},
						offersAlways: true,
					},
				},
			]);
			assert.strictEqual(running.transcript.items.length, 2);
			const settled = fold(running, events);
			assert.deepStrictEqual(settled.transcript.items, []);
			assert.deepStrictEqual(settled.permissions, {});
			assert.isNull(settled.interruption);
		}),
	);

	/** #8159's queue: a reset ends a turn, and a turn's end is what admits what was written under it. */
	it.effect("admits the prompt written during the command instead of discarding it", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			const queued = apply(sent(opened, "/clear", "k1"), {
				type: "prompt",
				text: "held while it ran",
				key: "k2",
				timestamp: SENT_AT + 1,
			})[0];
			assert.strictEqual(queued.queued.length, 1);
			const [settled, cmds] = apply(queued, {
				type: "event",
				sessionId: SESSION_ID,
				event: events[1] as AgentEvent,
			});
			assert.deepStrictEqual(settled.queued, []);
			assert.deepStrictEqual(cmds, [
				{type: "aiAgent.prompt", text: "held while it ran", key: "k2"},
			]);
		}),
	);

	/**
	 * `settleAccepted` reaches the oldest send whose turn a layer said had begun and no other, so a
	 * second send sitting in the gap a stale `ready` opens (#8107) keeps its window's copy.
	 */
	it.effect("accepts the send the command ran, never a second one still waiting", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([resetFrame]);
			// k1's turn ran and ended; k2 was sent after, so no layer has narrated a turn for it.
			const two = sent(fold(sent(opened, "/clear", "k1"), events), "next", "k2");
			const settled = fold(two, events.slice(1));
			assert.deepStrictEqual(settled.sends, [
				{key: "k1", state: "accepted"},
				{key: "k2", state: "pending", turn: "unstarted"},
			]);
		}),
	);
});

describe("what still does not end a turn", () => {
	/**
	 * The open union's whole point: an unrecognized kind is counted, not answered. `rate_limit_event`
	 * is the captured stand-in — a real member of `SDKMessage` that carries no turn outcome.
	 */
	it.effect("leaves the session prompting on a frame that says nothing about the turn", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([message("unknown-message")]);
			const settled = fold(sent(opened, "hello", "k1"), events);
			assert.strictEqual(settled.phase, "prompting");
			assert.deepStrictEqual(settled.sends, [{key: "k1", state: "pending", turn: "running"}]);
		}),
	);

	/**
	 * The event *is* the id, so a frame carrying none is skipped rather than swapping the session
	 * onto nothing. The captured notice behind it is what makes the run answer at all — a skipped
	 * frame emits nothing, which is the claim.
	 */
	it.effect("ignores a reset frame carrying no conversation id", () =>
		Effect.gen(function* () {
			const {events} = yield* cleared([malformed as SDKMessage, message("unknown-message")]);
			assert.deepStrictEqual(
				events.map((event) => event.kind),
				["phase", "item"],
			);
			const settled = fold(sent(opened, "/clear", "k1"), events);
			assert.strictEqual(settled.sessionId, SESSION_ID);
			assert.strictEqual(settled.phase, "prompting");
		}),
	);
});
