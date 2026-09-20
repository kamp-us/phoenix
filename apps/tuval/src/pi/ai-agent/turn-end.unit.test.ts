/**
 * The end of a Pi turn, when the pushes that would have carried it coalesce away.
 *
 * `ready` used to exist only as a difference between two *received* snapshots, and the server
 * signals a session's changes through a capacity-1 sliding queue — so a whole turn can collapse
 * into one read taken after it finished. The projection then sits at `ready` from before the send
 * to after it and emits nothing at all, while the core moved itself to `prompting` at the send.
 * Its `prompt` guard admits a session at `ready` only, so the next message is silently refused
 * (#7897).
 *
 * The interleaving is what a socket will not hand a test on demand, so these run over a stub
 * `PiClientService`: the snapshot stream is a queue the test pushes, and `prompt` settles when the
 * test says so, with the snapshot the turn ended on.
 */

import {assert, describe, it} from "@effect/vitest";
import {type Cause, Deferred, Effect, Layer, Option, Queue, Stream} from "effect";
import type {AgentEvent, TransportError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {
	type PiClientApi,
	PiClientService,
	type PiSessionRef,
	type SessionUpdate,
} from "../client/index.ts";
import type {TranscriptItem as PiTranscriptItem, SessionSnapshot} from "../wire/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/turn-end";
const SESSION: PiSessionRef = {
	id: "session-7897",
	cwd: CWD,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
};

const user: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

const reply: PiTranscriptItem = {
	id: "item-1",
	role: "assistant",
	content: [{type: "text", text: "hello"}],
	model: SESSION.model,
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
};

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

/** The stub server: a snapshot stream the test feeds, and a `prompt` the test settles. */
const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionUpdate, Cause.Done>();
	const ended = yield* Deferred.make<SessionSnapshot>();
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(snapshot([], "idle", 0)),
		prompt: () => Deferred.await(ended),
		abort: () => Effect.never,
		setModel: () => Effect.never,
		setThinkingLevel: () => Effect.never,
		models: Effect.succeed([]),
		updates: () => Stream.fromQueue(pushes),
		disconnections: Stream.never,
	};
	return {
		layer: Layer.succeed(PiClientService, api),
		push: (value: SessionSnapshot) => Queue.offer(pushes, {_tag: "snapshot", snapshot: value}),
		/** The turn's last update and the end of the stream carrying it, with no gap between. */
		pushAndEnd: (value: SessionSnapshot) =>
			Queue.offer(pushes, {_tag: "snapshot", snapshot: value}).pipe(
				Effect.andThen(Queue.end(pushes)),
			),
		/** Settle the send with the snapshot the turn ended on, as the server's answer does. */
		endTurn: (value: SessionSnapshot) => Deferred.succeed(ended, value),
	};
});

type Events = Queue.Dequeue<AgentEvent, TransportError | Cause.Done>;

/**
 * Every event up to and including the first one `found` accepts. Bounded, so a transition that
 * never arrives fails on the line that names it rather than hanging the suite out to a timeout.
 */
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
const isReply = (event: AgentEvent): boolean =>
	event.kind === "item" && event.item.kind === "assistant";

const readies = (events: ReadonlyArray<AgentEvent>): number => events.filter(isReady).length;

describe("a Pi turn whose pushes coalesced away", () => {
	it.live("still ends at ready, with the reply above it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				// The open's own `ready`, so what follows belongs to the turn.
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				// Nothing is pushed for the whole turn: the sliding change signal collapsed every
				// read into the one taken after it finished, which is the send's own answer.
				yield* client.endTurn(snapshot([user, reply], "idle", 1));

				const turn = yield* collectTo(events, "the turn's ready", isReady);
				assert.strictEqual(readies(turn), 1, "the end of the turn reached the core more than once");
				assert.isTrue(
					turn.findIndex(isReply) < turn.findIndex(isReady),
					"ready landed above the reply it belongs under",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("emits ready once when the pushes did land, not twice", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* client.push(snapshot([user], "turn", 1));
				// The whole turn, pushed: the transition is already on the stream before the send's
				// answer re-folds the same snapshot.
				yield* client.push(snapshot([user, reply], "idle", 2));
				const pushed = yield* collectTo(events, "the turn's ready", isReady);
				assert.strictEqual(readies(pushed), 1, "the push emitted the transition more than once");
				assert.isTrue(
					pushed.findIndex(isReply) < pushed.findIndex(isReady),
					"ready landed above the reply it belongs under",
				);

				yield* client.endTurn(snapshot([user, reply], "idle", 3));
				// The answer re-folds a snapshot the projection has already seen, so it is worth no
				// event at all — a window rendering in arrival order shows one `ready`, once.
				const after = yield* Queue.take(events).pipe(
					Effect.orDie,
					Effect.timeoutOption("250 millis"),
				);
				assert.isTrue(
					Option.isNone(after),
					`the settled snapshot repainted something already folded: ${JSON.stringify(after)}`,
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	/**
	 * The per-turn `result` this layer owes beside that end (#8724). A layer pays it by wrapping its
	 * own `events` in `withTurnResult` and nothing makes it, so the assertion is on the real stream:
	 * one result, immediately ahead of the `ready` that closes the turn, and none at the open.
	 */
	it.live("owes one result per finished turn, ahead of the ready that closes it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				const opening = yield* collectTo(events, "the opened session's ready", isReady);
				assert.isEmpty(
					opening.filter((event) => event.kind === "result"),
					"the open is not a turn, and owes no answer",
				);

				yield* agent.prompt("say hello");
				yield* client.endTurn(snapshot([user, reply], "idle", 1));

				const turn = yield* collectTo(events, "the turn's ready", isReady);
				const results = turn.filter((event) => event.kind === "result");
				assert.lengthOf(results, 1, "the layer owes exactly one result per finished turn");
				assert.strictEqual(turn.indexOf(results[0]!), turn.length - 2);
				assert.deepStrictEqual(
					{text: results[0]!.result.text, ok: results[0]!.result.ok},
					{text: "hello", ok: true},
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	/**
	 * The update stream ending is not the fold ending. `follow` used to race the two, so the moment
	 * the stream ran out the fold was interrupted with the turn's last update still queued and
	 * unfolded — the operator's window kept `prompting` under a turn that had finished (#8554).
	 */
	it.live("folds the turn's last update even when the stream ends behind it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* client.pushAndEnd(snapshot([user, reply], "idle", 1));

				const turn = yield* collectTo(events, "the turn's ready", isReady);
				assert.isTrue(
					turn.some(isReply),
					"the reply the ended stream carried never reached the window",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
