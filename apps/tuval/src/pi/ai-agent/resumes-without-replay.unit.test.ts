/**
 * What a resume owes the window, over a stub `PiClientService` whose snapshot stream is a queue the
 * test pushes.
 *
 * Pi re-sends the whole transcript every revision, so the fold's projection is the only thing
 * standing between a reattach and a full replay of the session as live items. A restored process
 * comes back with that transcript already on screen, and the replay lands on top of the operator's
 * own newly typed turn, pushing it out of the 40-item window (#8369). A window opened on a session
 * out of the picker holds nothing, and the same replay is the only way its history paints — so both
 * halves are pinned here.
 */

import type {
	TranscriptItem as PiTranscriptItem,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {type Cause, Effect, Layer, Option, Queue, Stream} from "effect";
import type {AgentEvent, TransportError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {type PiClientApi, PiClientService, type PiSessionRef} from "../client/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/resume";
const SESSION: PiSessionRef = {
	id: "session-8369",
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
	usage: {
		input: 11,
		output: 22,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 33,
		cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42},
	},
};

const sent: PiTranscriptItem = {
	id: "item-2",
	role: "user",
	content: [{type: "text", text: "and again"}],
	timestamp: 12,
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
	locked: false,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

/** The transcript the session already had when this client attached to it. */
const HELD = snapshot([user, reply], "idle", 7);

const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionSnapshot>();
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(HELD),
		prompt: () => Effect.never,
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
	};
});

type Events = Queue.Dequeue<AgentEvent, TransportError | Cause.Done>;

/** Every event the stream holds now, drained until it goes quiet. */
const drain = (events: Events) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("250 millis"));
			if (Option.isNone(next)) return seen;
			seen.push(next.value);
		}
	});

const itemIds = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<string> =>
	events.flatMap((event) => (event.kind === "item" ? [event.item.id] : []));

const usages = (events: ReadonlyArray<AgentEvent>): number =>
	events.filter((event) => event.kind === "usage").length;

describe("a Pi session resumed by a caller that already holds its transcript", () => {
	it.live(
		"emits no item and no usage when the first push carries the transcript it opened on",
		() =>
			Effect.gen(function* () {
				const client = yield* stub;

				yield* Effect.gen(function* () {
					const agent = yield* TuvalAiAgent;
					yield* agent.start({cwd: CWD, resume: SESSION.id, holdsTranscript: true});
					const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
					yield* drain(events);

					yield* client.push(HELD);
					const folded = yield* drain(events);
					assert.deepStrictEqual(itemIds(folded), [], "the resume replayed the transcript");
					assert.strictEqual(usages(folded), 0, "the resume re-added the session's usage");
				}).pipe(
					Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))),
					Effect.scoped,
				);
			}),
	);

	it.live("emits the operator's own turn, and nothing under it, on the push that carries it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD, resume: SESSION.id, holdsTranscript: true});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(snapshot([user, reply, sent], "turn", 8));
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[sent.id],
					"the send arrived under a replay of the history above it",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live(
		"still replays the history for a caller that holds none, which is how the picker paints",
		() =>
			Effect.gen(function* () {
				const client = yield* stub;

				yield* Effect.gen(function* () {
					const agent = yield* TuvalAiAgent;
					yield* agent.start({cwd: CWD, resume: SESSION.id});
					const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
					yield* drain(events);

					yield* client.push(HELD);
					const folded = yield* drain(events);
					assert.deepStrictEqual(
						itemIds(folded),
						[user.id, reply.id],
						"a window opened on a past session came up empty",
					);
				}).pipe(
					Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))),
					Effect.scoped,
				);
			}),
	);

	it.live("opens a fresh session on an empty projection, so its first snapshot paints", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(snapshot([user], "turn", 1));
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[user.id],
					"a fresh session's first item was eaten",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
