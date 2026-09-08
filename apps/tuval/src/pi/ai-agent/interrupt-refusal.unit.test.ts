/**
 * A Pi abort the server would not take, over the layer's real event path (#8007, ADR 0356).
 *
 * The same contract the Claude layer owes, proved separately because the two answer it from
 * different places: Pi's refusal says nothing about the turn, so `turnRunning` comes off the
 * layer's own session projection rather than off a turn-state flag. A layer that read that wrong
 * would send the fold to the other arm and walk a running turn to `ready`.
 *
 * Limits of the proof: the server is a stub, so what runs is the mapping from a refused
 * `PiClientService.abort` to the event the core folds — not a real Pi abort, and not the conditions
 * under which a real server refuses one.
 */

import {assert, describe, it} from "@effect/vitest";
import {type Cause, Deferred, Effect, Layer, Option, Queue, Stream} from "effect";
import type {AgentEvent, TransportError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {
	type PiClientApi,
	PiClientService,
	type PiSessionRef,
	SessionLocked,
	type SessionUpdate,
} from "../client/index.ts";
import type {SessionSnapshot} from "../wire/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/interrupt-refusal";
const SESSION: PiSessionRef = {
	id: "session-8007",
	cwd: CWD,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
};

const snapshot = (phase: SessionSnapshot["phase"], revision: number): SessionSnapshot => ({
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
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
});

/** The stub server: a snapshot stream the test feeds, a `prompt` it settles, an `abort` that says no. */
const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionUpdate>();
	const ended = yield* Deferred.make<SessionSnapshot>();
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(snapshot("idle", 0)),
		prompt: () => Deferred.await(ended),
		abort: () =>
			Effect.fail(new SessionLocked({sessionId: SESSION.id, detail: "the session is not yours"})),
		setModel: () => Effect.never,
		setThinkingLevel: () => Effect.never,
		models: Effect.succeed([]),
		updates: () => Stream.fromQueue(pushes),
		disconnections: Stream.never,
	};
	return {
		layer: Layer.succeed(PiClientService, api),
		endTurn: (value: SessionSnapshot) => Deferred.succeed(ended, value),
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

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isFailure = (event: AgentEvent): boolean => event.kind === "failure";

const failureOf = (events: ReadonlyArray<AgentEvent>) => {
	const one = events.at(-1);
	assert.isTrue(one?.kind === "failure", "the last event collected is not the refusal");
	return (one as Extract<AgentEvent, {kind: "failure"}>).failure;
};

describe("a Pi abort the server refuses", () => {
	it.live("rides the event stream as its own failure tag while the turn is still running", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;

				const failure = failureOf(yield* collectTo(events, "the refused abort", isFailure));
				assert.strictEqual(failure.tag, "tuval/ai-agent/InterruptError");
				assert.strictEqual(failure.reason, "turn-running");
				assert.include(failure.detail, "the session is not yours");
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	// Nothing was running, so the refusal is the server saying there is no turn to stop — the arm
	// the fold walks back to `ready`, and the one that unfroze the founder's desk on 2026-09-05.
	it.live("says there was no live turn when the session is not on one", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.interrupt;
				const failure = failureOf(yield* collectTo(events, "the refused abort", isFailure));
				assert.strictEqual(failure.reason, "no-live-turn");
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	// The refusal is an event, never the end of the stream: the session is still there and every
	// later turn still has to reach the window.
	it.live("leaves the stream open, so the turn it would not stop still ends on it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;
				yield* collectTo(events, "the refused abort", isFailure);

				yield* client.endTurn(snapshot("idle", 2));
				yield* collectTo(events, "the turn's own end", isReady);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
