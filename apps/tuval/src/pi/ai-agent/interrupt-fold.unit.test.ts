/**
 * Escape's own answer, when the push that would have carried the turn's end never arrives (#8632).
 *
 * `pi.abort` is answered after `session.abort()` resolved (`../server/dispatch.ts`), so the snapshot
 * it returns is the turn's terminal phase and terminal transcript. Dropping it left the window on
 * Working with no route out but a desk restart, because the operator's one control published
 * nothing.
 *
 * Limits of the proof: the server is a stub, so what runs is the layer's fold of an abort answer —
 * not a real Pi abort, and not the conditions under which a real push is lost.
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

const CWD = "/tuval/interrupt-fold";
const SESSION: PiSessionRef = {
	id: "session-8632",
	cwd: CWD,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
};

const user: PiTranscriptItem = {
	id: "item-370",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

/** The turn Escape cut: nothing written, and the wire's `aborted` status is the whole record of it. */
const aborted: PiTranscriptItem = {
	id: "item-371",
	role: "assistant",
	content: [],
	model: SESSION.model,
	timestamp: 11,
	status: "aborted",
	stopReason: "aborted",
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

/**
 * The #8468 control: a snapshot stream the test feeds, a `prompt` that never answers — the turn
 * whose end was lost — and an `abort` the test settles with the server's own terminal snapshot.
 */
const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionUpdate>();
	const stopped = yield* Deferred.make<SessionSnapshot>();
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(snapshot([], "idle", 0)),
		prompt: () => Effect.never,
		abort: () => Deferred.await(stopped),
		setModel: () => Effect.never,
		setThinkingLevel: () => Effect.never,
		models: Effect.succeed([]),
		updates: () => Stream.fromQueue(pushes),
		disconnections: Stream.never,
	};
	return {
		layer: Layer.succeed(PiClientService, api),
		push: (value: SessionSnapshot) => Queue.offer(pushes, {_tag: "snapshot", snapshot: value}),
		/** Answer the abort, as the server does once `session.abort()` has resolved. */
		endAbort: (value: SessionSnapshot) => Deferred.succeed(stopped, value),
	};
});

type Events = Queue.Dequeue<AgentEvent, TransportError | Cause.Done>;

/** Every event up to and including the first one `found` accepts, bounded so a miss names itself. */
const collectTo = (events: Events, what: string, found: (event: AgentEvent) => boolean) =>
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

/** Everything the stream still had to say, up to the point it went quiet. */
const quiet = (events: Events) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("250 millis"));
			if (Option.isNone(next)) return seen;
			seen.push(next.value);
		}
	});

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isInterrupted = (event: AgentEvent): boolean =>
	event.kind === "item" && event.item.kind === "assistant" && event.item.interrupted === true;

describe("a Pi abort whose turn-end push never arrived", () => {
	it.live("publishes the interrupted turn and then ready, off the abort's own answer", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				// One push says the turn is live, and it is the last thing the stream carries.
				yield* client.push(snapshot([user], "turn", 1));
				yield* collectTo(events, "the turn's prompting", isPrompting);

				yield* client.endAbort(snapshot([user, aborted], "idle", 2));
				yield* agent.interrupt;

				const after = yield* collectTo(events, "the aborted turn's ready", isReady);
				const row = after.findIndex(isInterrupted);
				assert.isTrue(
					row >= 0,
					`the aborted turn never reached the window: ${JSON.stringify(after)}`,
				);
				assert.isTrue(row < after.findIndex(isReady), "ready landed above the turn it ended");
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	// The published phase is the backend's own answer and nothing else, so an abort still in flight
	// has nothing to fold — the window stays on the turn rather than being walked to a fake settle
	// (#8007, ADR 0356).
	it.live("settles nothing while the abort is still in flight", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* client.push(snapshot([user], "turn", 1));
				yield* collectTo(events, "the turn's prompting", isPrompting);

				yield* Effect.forkChild(agent.interrupt);
				const after = yield* quiet(events);
				assert.isTrue(
					after.every((event) => event.kind !== "phase"),
					`a pending abort moved the window's phase: ${JSON.stringify(after)}`,
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
