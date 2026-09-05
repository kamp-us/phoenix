/**
 * Three things a turn owes that only a held-open or refused transport can show: the idempotency key
 * is recorded at the send, so the in-flight retry it exists for is dropped (ruling 2, #7570), a
 * failed `start` leaves a terminal phase on the one stream rather than `starting` (ruling 1), and a
 * model switch reaches the session's own lease rather than opening a second one (#7981).
 *
 * Both turn on *when* a `prompt` or `attach` settles, which is the one thing a real socket does not
 * hand a test, so they run over a stub `PiClientService` — the mapping half alone, no server and no
 * wall clock.
 */

import type {ModelMetadata, ModelRef, SessionSnapshot} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Deferred, Effect, Fiber, Layer, Queue, Ref, Stream} from "effect";
import {type AgentEvent, type TransportError, TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {
	type PiClientApi,
	PiClientService,
	type PiSessionRef,
	SessionLocked,
} from "../client/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/turn";
const SESSION: PiSessionRef = {
	id: "session-1",
	cwd: CWD,
	model: {provider: "anthropic", id: "opus"},
};

/** What the server answers a `set_model` with. Only `model` is read; the rest is the wire's shape. */
const SNAPSHOT: SessionSnapshot = {
	id: SESSION.id,
	cwd: CWD,
	createdAt: 0,
	updatedAt: 0,
	phase: "idle",
	model: SESSION.model,
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision: 1,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
};

interface StubOptions {
	/** Completed once a send has entered, and awaited before it settles: one send, held open. */
	readonly hold?: {
		readonly entered: Deferred.Deferred<void>;
		readonly release: Deferred.Deferred<void>;
	};
	/** Refuses `attachSession`, which is what a `start({resume})` against a held session meets. */
	readonly lockAttach?: boolean;
	/** The server's `hello` catalog, as `PiClientApi.models` answers it. */
	readonly catalog?: ReadonlyArray<ModelMetadata>;
}

/** One catalog row, with everything the layer does not read left at a plausible constant. */
const catalogRow = (provider: string, id: string, name: string): ModelMetadata => ({
	provider,
	id,
	name,
	api: "anthropic",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 8_192,
	cost: {input: 1, output: 1, cacheRead: 1, cacheWrite: 1},
	supportedThinkingLevels: ["off"],
	authenticated: true,
});

const stub = (options: StubOptions) =>
	Effect.gen(function* () {
		const sends = yield* Ref.make<ReadonlyArray<string>>([]);
		const switched = yield* Ref.make<ReadonlyArray<ModelRef>>([]);
		const api: PiClientApi = {
			connect: Effect.void,
			reconnect: Effect.void,
			connected: Effect.succeed(true),
			createSession: () => Effect.succeed(SESSION),
			attachSession: (sessionId) =>
				options.lockAttach === true
					? Effect.fail(new SessionLocked({sessionId, detail: "another connection holds it"}))
					: Effect.succeed(SESSION),
			prompt: (_sessionId, text) =>
				Effect.gen(function* () {
					yield* Ref.update(sends, (seen) => [...seen, text]);
					if (options.hold === undefined) return yield* Effect.never;
					yield* Deferred.succeed(options.hold.entered, undefined);
					yield* Deferred.await(options.hold.release);
					return yield* Effect.never;
				}),
			abort: () => Effect.never,
			setModel: (_sessionId, model) =>
				Effect.as(
					Ref.update(switched, (seen) => [...seen, model]),
					{...SNAPSHOT, model},
				),
			models: Effect.succeed(options.catalog ?? []),
			snapshots: () => Stream.never,
			disconnections: Stream.never,
		};
		return {
			layer: Layer.succeed(PiClientService, api),
			sends: Ref.get(sends),
			switched: Ref.get(switched),
		};
	});

/**
 * Everything the layer has buffered on the live queue, without waiting for a stream to end. The
 * queue is unbounded and holds the whole failed start, so neither the stream's `TransportError` nor
 * a done queue can arise here and both die rather than widening this helper's channel.
 */
const buffered = (events: Stream.Stream<AgentEvent, TransportError>) =>
	Effect.scoped(
		Effect.flatMap(Stream.toQueue(events, {capacity: "unbounded"}), Queue.takeAll),
	).pipe(Effect.orDie);

describe("the idempotency key", () => {
	it.effect("drops a second send under a key whose first send is still in flight", () =>
		Effect.gen(function* () {
			const hold = {
				entered: yield* Deferred.make<void>(),
				release: yield* Deferred.make<void>(),
			};
			const client = yield* stub({hold});

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});

				const inFlight = yield* Effect.forkChild(agent.prompt("say hello", "key-1"));
				yield* Deferred.await(hold.entered);

				// The first send is parked, which is exactly the window a transport-level retry of
				// it fires in.
				yield* agent.prompt("say hello", "key-1");
				assert.deepStrictEqual(
					yield* client.sends,
					["say hello"],
					"the retry read the key the first send had already recorded",
				);

				yield* Fiber.interrupt(inFlight);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});

describe("the model switch", () => {
	const CATALOG = [
		catalogRow("anthropic", "opus", "Opus 5"),
		catalogRow("anthropic", "sonnet", "Sonnet 5"),
	];

	it.effect("sends set_model on the session's own lease and announces what came back", () =>
		Effect.gen(function* () {
			const client = yield* stub({catalog: CATALOG});

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				yield* agent.setModel({provider: "anthropic", id: "sonnet", name: "Sonnet 5"});

				assert.deepStrictEqual(
					yield* client.switched,
					[{provider: "anthropic", id: "sonnet"}],
					"the wire ref carries the provider and the id, never the picker's label",
				);
				assert.deepStrictEqual(
					(yield* buffered(agent.events)).filter((event) => event.kind === "model").at(-1),
					{
						kind: "model",
						current: {provider: "anthropic", id: "sonnet", name: "Sonnet 5"},
						available: [
							{provider: "anthropic", id: "opus", name: "Opus 5"},
							{provider: "anthropic", id: "sonnet", name: "Sonnet 5"},
						],
					},
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.effect("refuses a model the server's catalog does not offer", () =>
		Effect.gen(function* () {
			const client = yield* stub({catalog: CATALOG});

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const refused = yield* Effect.flip(agent.setModel({id: "gpt", name: "GPT"}));
				assert.strictEqual(refused._tag, "tuval/ai-agent/ModelUnsupported");
				assert.deepStrictEqual(yield* client.switched, []);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});

describe("a failed start", () => {
	it.effect("leaves a terminal phase on the stream rather than starting", () =>
		Effect.gen(function* () {
			const client = yield* stub({lockAttach: true});

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const refused = yield* Effect.flip(agent.start({cwd: CWD, resume: SESSION.id}));
				assert.strictEqual(refused.reason, "session-locked");

				assert.deepStrictEqual(
					(yield* buffered(agent.events)).filter((event) => event.kind === "phase"),
					[
						{kind: "phase", phase: "starting"},
						{kind: "phase", phase: "gone"},
					],
					"a subscriber that missed the failure still reads where the session ended up",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
