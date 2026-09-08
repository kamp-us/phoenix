/**
 * The reproduction for #8214: why a send the core admitted reaches Pi mid-turn and is refused with
 * `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the
 * message.`
 *
 * Three claims, in the order the failure travels. The layer emits a `ready` under a live turn; the
 * core admits the next prompt on that `ready`; and the pinned wire cannot carry the field Pi's own
 * error names, so the remedy cannot live on the prompt command.
 *
 * The variable is the send, not the order of the pair: whichever of a turn's push and its answer
 * lands *after* the next send's `sent` mark re-folds a stale `idle` into a second `ready`. Both
 * orders are here, and so is the same schedule with nothing sent in the gap.
 *
 * The findings this pins are written up in
 * `reports/2026-09-07-pi-mid-turn-prompt-refusal.md`. Nothing here asserts a fix: the tests describe
 * the mechanism as current source runs it, so a fix reds the first one by name.
 */

import {applyCellChecked} from "@demlik/tea";
import {
	type ClientMessage,
	type TranscriptItem as PiTranscriptItem,
	ProtocolValidationError,
	parseClientMessage,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {type Cause, Deferred, Effect, Layer, Option, Queue, Stream} from "effect";
import {aiAgentSessionMachine} from "../../ai-agent/core/machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "../../ai-agent/core/messages.ts";
import {type AiAgentSessionState, initialState} from "../../ai-agent/core/state.ts";
import type {AgentEvent, TransportError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {type PiClientApi, PiClientService, type PiSessionRef} from "../client/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/mid-turn";
const SESSION: PiSessionRef = {
	id: "session-8214",
	cwd: CWD,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
};

const user = (id: string, text: string): PiTranscriptItem => ({
	id,
	role: "user",
	content: [{type: "text", text}],
	timestamp: 10,
});

const reply = (id: string, text: string): PiTranscriptItem => ({
	id,
	role: "assistant",
	content: [{type: "text", text}],
	model: SESSION.model,
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
});

const snapshot = (
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"],
	revision: number,
): SessionSnapshot => ({
	id: SESSION.id,
	cwd: CWD,
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: SESSION.model,
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

const USER_A = user("u-0", "first");
const REPLY_A = reply("a-0", "first reply");
const TURN_A = [USER_A, REPLY_A];

/**
 * The stub server, with one settleable answer per send rather than one for the session: the
 * schedule under test is exactly a *previous* send's answer landing after a later send has gone
 * out, which one shared Deferred cannot express.
 */
const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionSnapshot>();
	const first = yield* Deferred.make<SessionSnapshot>();
	const second = yield* Deferred.make<SessionSnapshot>();
	const answers = [first, second];
	let sent = 0;
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(snapshot([], "idle", 0)),
		// Read at call time, on the fiber that called `prompt`, so the nth send takes the nth
		// answer in the order the layer issued them.
		prompt: () => {
			const answer = answers[sent];
			sent += 1;
			return answer === undefined ? Effect.never : Deferred.await(answer);
		},
		abort: () => Effect.never,
		setModel: () => Effect.never,
		setThinkingLevel: () => Effect.never,
		models: Effect.succeed([]),
		snapshots: () => Stream.fromQueue(pushes),
		disconnections: Stream.never,
	};
	return {
		layer: Layer.succeed(PiClientService, api),
		push: (value: SessionSnapshot) => Queue.offer(pushes, value),
		/** Settle the nth send's own answer, as the server's response frame does. */
		answer: (nth: 0 | 1, value: SessionSnapshot) =>
			Deferred.succeed(nth === 0 ? first : second, value),
	};
});

type Events = Queue.Dequeue<AgentEvent, TransportError | Cause.Done>;

const collectTo = (events: Events, what: string, found: (event: AgentEvent) => boolean) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("5 seconds"));
			if (Option.isNone(next)) {
				assert.fail(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`);
			}
			const event = next.value;
			seen.push(event);
			if (found(event)) return seen;
		}
	});

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";

/** Whatever the layer emitted in a quarter second, or nothing. */
const settled = (events: Events) =>
	Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("250 millis"));

describe("a send admitted while Pi is still running the previous turn", () => {
	it.live("pushes turn A's end, then re-emits ready from A's late answer under live turn B", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("first");
				yield* client.push(snapshot([USER_A], "turn", 1));
				// Turn A ends on the push, ahead of its own answer frame.
				yield* client.push(snapshot(TURN_A, "idle", 2));
				yield* collectTo(events, "turn A's ready", isReady);

				// The core admits on that `ready`. The send's `sent` mark walks the projection back
				// to `prompting`, which is what makes the stale answer a difference again.
				yield* agent.prompt("second");
				yield* collectTo(events, "turn B's prompting", isPrompting);

				// A's answer, arriving after B went out. `SnapshotProjection` carries no revision
				// (`./items.ts`), so `eventsOf` has nothing to compare and folds it as current.
				yield* client.answer(0, snapshot(TURN_A, "idle", 2));

				const late = yield* settled(events);
				assert.isTrue(
					Option.isSome(late) && isReady(late.value),
					`turn A's late answer emitted ${JSON.stringify(late)} rather than a second ready`,
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("does the same answer-first, so the pair's order is not the variable", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("first");
				// A's answer wins the race this time, and turn A's end reaches the core from it.
				yield* client.answer(0, snapshot(TURN_A, "idle", 2));
				yield* collectTo(events, "turn A's ready", isReady);

				yield* agent.prompt("second");
				yield* collectTo(events, "turn B's prompting", isPrompting);

				// A's push, arriving after B went out — the same stale `idle` from the other side.
				yield* client.push(snapshot(TURN_A, "idle", 2));

				const late = yield* settled(events);
				assert.isTrue(
					Option.isSome(late) && isReady(late.value),
					`answer-first emitted ${JSON.stringify(late)} rather than a second ready`,
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("emits nothing late when no send lands in the gap — the send is the variable", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("first");
				yield* client.push(snapshot([USER_A], "turn", 1));
				yield* client.push(snapshot(TURN_A, "idle", 2));
				yield* collectTo(events, "turn A's ready", isReady);

				// The same late answer as the first case, with nothing sent in between: the
				// projection is still at `ready`, so the stale snapshot is worth no event at all.
				yield* client.answer(0, snapshot(TURN_A, "idle", 2));

				const late = yield* settled(events);
				assert.isTrue(
					Option.isNone(late),
					`the late answer emitted ${JSON.stringify(late)} with no send in the gap`,
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

describe("what the core does with that second ready", () => {
	it("admits the operator's next send instead of queueing it", () => {
		const running: AiAgentSessionState = {
			...initialState(CWD),
			phase: "prompting",
			sessionId: SESSION.id,
		};

		const [ready] = apply(running, {
			type: "event",
			sessionId: SESSION.id,
			event: {kind: "phase", phase: "ready"},
		});
		assert.strictEqual(ready.phase, "ready");

		const [after, cmds] = apply(ready, {
			type: "prompt",
			text: "third",
			key: "key-c",
			timestamp: 1_700_000_000_000,
		});
		// Admitted, not queued: the text goes to the layer, which hands it to a session Pi is
		// still running.
		assert.deepStrictEqual(after.queued, []);
		assert.isTrue(
			cmds.some((cmd) => cmd.type === "aiAgent.prompt"),
			`the core queued rather than admitting: ${JSON.stringify(cmds)}`,
		);
	});
});

const request = (command: Record<string, unknown>): unknown => ({
	type: "request",
	id: "req-1",
	request: command,
});

describe("the pinned pi-protocol prompt command", () => {
	/**
	 * `PromptCommandSchema` is a `StrictObject` (`additionalProperties: false`, `dist/schemas.js`),
	 * so `streamingBehavior` is not a field a caller may add to the wire — the frame is refused
	 * before it reaches a session. Pi's error names an option on the *SDK*'s `PromptOptions`
	 * (`pi-coding-agent/dist/core/agent-session.d.ts`), which is a different surface.
	 */
	it("refuses a prompt carrying streamingBehavior, and takes the same prompt without it", () => {
		const bare = request({command: "prompt", sessionId: SESSION.id, text: "hello"});
		assert.deepStrictEqual(parseClientMessage(bare), bare as ClientMessage);

		assert.throws(
			() =>
				parseClientMessage(
					request({
						command: "prompt",
						sessionId: SESSION.id,
						text: "hello",
						streamingBehavior: "followUp",
					}),
				),
			ProtocolValidationError,
		);
	});

	it("already carries steer as its own command, so that arm needs no wire change", () => {
		const steer = request({command: "steer", sessionId: SESSION.id, text: "hello"});
		assert.deepStrictEqual(parseClientMessage(steer), steer as ClientMessage);
	});
});
