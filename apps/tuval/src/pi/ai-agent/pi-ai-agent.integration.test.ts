/**
 * The vertical proof for this slice: `PiAiAgent` driving a real `AgentSession` at the pinned Pi
 * 0.84.3 over a real loopback socket, on Pi's own faux provider so the run costs nothing and calls
 * no model API (`@earendil-works/pi-ai` `dist/index.d.ts` re-exports `providers/faux`).
 *
 * Every wait is bounded and names what it was waiting for, so a broken stage reads off the
 * failure line rather than a suite timeout (`.patterns/ci-legible-integration-tests.md`).
 */

import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage, fauxProvider, fauxToolCall} from "@earendil-works/pi-ai";
import type {ByteTransport, ByteTransportFactory} from "@earendil-works/pi-client";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Queue, Redacted, Stream} from "effect";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	type AgentEvent,
	StartError,
	TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
} from "../../ai-agent/service/index.ts";
import {PiClientService, webSocketTransportFactory} from "../client/index.ts";
import {agentSessionHostLayer, PiServerService, SessionOpenFailed} from "../server/index.ts";
import {aiAgentOverClient, aiAgentOverHost} from "./PiAiAgent.ts";

const MODEL = {provider: "faux", id: "faux-1"} as const;

/** Long enough for a pushed snapshot to land, short enough to fail inside the suite budget. */
const SETTLE = "500 millis";

const setUp = (responses = [fauxAssistantMessage("hello from faux")]) => {
	const cwd = mkdtempSync(join(tmpdir(), "tuval-pi-ai-agent-"));
	const faux = fauxProvider({
		provider: MODEL.provider,
		api: "faux",
		models: [{id: MODEL.id, cost: {input: 3, output: 15, cacheRead: 0, cacheWrite: 0}}],
	});
	faux.setResponses([...responses]);
	return {cwd, faux};
};

const hostLayer = (cwd: string, provider: ReturnType<typeof fauxProvider>) =>
	Layer.unwrap(
		Effect.tryPromise({
			try: async () => {
				const modelRuntime = await ModelRuntime.create({
					modelsPath: null,
					refreshOnCreate: false,
					allowModelNetwork: false,
					authPath: join(cwd, "agent", "auth.json"),
				});
				modelRuntime.registerNativeProvider(provider.provider);
				return agentSessionHostLayer({
					modelRuntime,
					agentDir: join(cwd, "agent"),
					noTools: "all",
				});
			},
			catch: (cause) => new SessionOpenFailed({cwd, detail: String(cause)}),
		}).pipe(Effect.orDie),
	);

/**
 * A real transport the test can drop out from under the client.
 *
 * Closing the transport is not enough on its own: `WebSocketByteTransport.close()` marks the
 * termination local before closing the socket, so the `close` event that follows raises no
 * `onClose` — a caller that closed a transport already knows it is gone
 * ([`../client/transport.ts`](../client/transport.ts)). A peer-side drop is the socket dying *and*
 * the client being told, so this delivers both: the real socket closes, and the handlers get the
 * terminal notification the far side's close would have carried.
 */
const droppable = (url: string): {factory: ByteTransportFactory; drop: () => void} => {
	const open = webSocketTransportFactory({url});
	let live: ByteTransport | undefined;
	let notifyClosed: (() => void) | undefined;
	return {
		factory: async (handlers) => {
			notifyClosed = handlers.onClose;
			live = await open(handlers);
			return live;
		},
		drop: () => {
			live?.close();
			notifyClosed?.();
		},
	};
};

/**
 * Everything the agent has pushed so far. The layer's queue is unbounded and buffers from `start`,
 * so a subscription taken after a settled prompt still sees the whole run in order — which makes
 * this a drain rather than a race.
 */
const drain = (agent: TuvalAiAgentApi) =>
	Effect.gen(function* () {
		const queue = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
		yield* Effect.sleep(SETTLE);
		return yield* Queue.takeAll(queue);
	});

const items = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<TranscriptItem> =>
	events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

describe("the Pi AI agent layer over a real AgentSession", () => {
	it.live(
		"starts, prompts, and pushes user, assistant and tool items with a usage event",
		() => {
			const {cwd, faux} = setUp([
				fauxAssistantMessage([fauxToolCall("read_file", {path: "README.md"})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("that tool is not available here"),
			]);
			return Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const started = yield* agent.start({cwd});
				assert.isNotEmpty(started.sessionId);

				yield* agent.prompt("read the readme", "key-1");
				const events = yield* drain(agent);

				assert.deepEqual(
					events.slice(0, 4).map((event) => event.kind),
					["phase", "mode", "model", "phase"],
					"start advertises the mode and model lists before settling on ready",
				);
				assert.deepEqual(
					[events[0], events[1], events[3]],
					[
						{kind: "phase", phase: "starting"},
						{kind: "mode", current: null, available: []},
						{kind: "phase", phase: "ready"},
					],
					"start advertises no modes and settles on ready",
				);
				// The offered set is the server's own `hello` catalog, so the session's model is one of
				// the rows the picker would list rather than a name this test invents.
				const announced = events[2];
				assert.strictEqual(announced?.kind, "model");
				if (announced?.kind === "model") {
					assert.isNotNull(announced.current);
					assert.includeDeepMembers(
						[...announced.available],
						announced.current === null ? [] : [announced.current],
						"the session's model is one the catalog offers",
					);
				}

				const kinds = new Set(items(events).map((item) => item.kind));
				assert.isTrue(
					kinds.has("user") && kinds.has("assistant") && kinds.has("tool"),
					`expected user, assistant and tool items; got ${[...kinds].join(", ")}`,
				);

				const tool = items(events).findLast((item) => item.kind === "tool");
				assert.isDefined(tool, "the tool call reached the window as a tool row");
				if (tool?.kind === "tool") {
					assert.strictEqual(tool.name, "read_file");
					assert.deepStrictEqual(tool.input, {path: "README.md"});
				}

				const usage = events.findLast((event) => event.kind === "usage");
				assert.isDefined(usage, "an assistant turn reported its usage");
				if (usage?.kind === "usage") {
					assert.strictEqual(usage.model, `${MODEL.provider}/${MODEL.id}`);
					assert.isAbove(usage.inputTokens + usage.outputTokens, 0);
					// The faux provider prices every turn at zero (`dist/providers/faux.js`'s usage
					// block), so the number is real and the amount is not; that a non-zero cost
					// reaches the event is pinned in `items.unit.test.ts`.
					assert.strictEqual(usage.cost, 0);
				}

				assert.strictEqual(faux.state.callCount, 2, "the tool loop ran two model turns");
			}).pipe(
				Effect.scoped,
				Effect.provide(aiAgentOverHost({model: MODEL}).pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);

	it.live(
		"pages older history out of the JSONL session, oldest-first, with atomic groups intact",
		() => {
			const {cwd, faux} = setUp([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("third answer"),
			]);
			return Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd});
				yield* agent.prompt("first question");
				yield* agent.prompt("second question");
				yield* agent.prompt("third question");

				const newest = yield* agent.page(null, 2);
				assert.isTrue(newest.hasMore, "three exchanges do not fit in a two-item page");
				assert.deepStrictEqual(
					newest.items.map((item) => item.kind),
					["user", "assistant"],
					"a page ends on whole exchanges, never mid-turn",
				);
				assert.strictEqual(
					newest.items[0]?.kind === "user" ? newest.items[0].text : "",
					"third question",
				);

				const older = yield* agent.page(newest.items[0]?.id ?? null, 2);
				assert.deepStrictEqual(
					older.items.map((item) => (item.kind === "user" ? item.text : item.kind)),
					["second question", "assistant"],
					"the next page walks older, still oldest-first",
				);

				const oldest = yield* agent.page(older.items[0]?.id ?? null, 2);
				assert.isFalse(oldest.hasMore, "the walk reaches the beginning of the session");
			}).pipe(
				Effect.scoped,
				Effect.provide(aiAgentOverHost({model: MODEL}).pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);

	it.live(
		"refuses a locked session and a missing one, and surfaces one Disconnected per drop",
		() => {
			const {cwd, faux} = setUp([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("after the drop"),
			]);
			return Effect.gen(function* () {
				const server = yield* PiServerService;
				const url = Redacted.value(server.url);
				const socket = droppable(url);

				// The owner's layer wraps the second one, so both clients are live at once — the
				// lock is the owner's open connection, not a record it leaves behind.
				yield* Effect.gen(function* () {
					const owner = yield* TuvalAiAgent;
					const started = yield* owner.start({cwd});
					const stream = yield* Stream.toQueue(owner.events, {capacity: "unbounded"});
					yield* owner.prompt("first question");

					yield* Effect.gen(function* () {
						const intruder = yield* TuvalAiAgent;
						const locked = yield* Effect.flip(intruder.start({cwd, resume: started.sessionId}));
						assert.instanceOf(locked, StartError);
						assert.strictEqual(locked.reason, "session-locked");

						const missing = yield* Effect.flip(intruder.start({cwd, resume: "no-such-session"}));
						assert.strictEqual(missing.reason, "session-not-found");
					}).pipe(
						Effect.provide(
							aiAgentOverClient({model: MODEL}).pipe(
								Layer.provide(PiClientService.layerWebSocket({url})),
							),
						),
					);

					socket.drop();
					// Draining rather than taking: the stream ends only on the failure, so this
					// cannot race the snapshot events still buffered ahead of it.
					const dropped = yield* Effect.flip(
						Stream.runDrain(Stream.fromQueue(stream)).pipe(Effect.timeout("10 seconds")),
					);
					assert.instanceOf(
						dropped,
						TransportError,
						"the drop failed the event stream once rather than timing it out",
					);
					assert.strictEqual(dropped.reason, "disconnected");

					// Nothing heals itself: a subscription taken after the drop fails the same way,
					// so the only way back in is another start.
					const stillDown = yield* Effect.flip(
						Stream.runDrain(owner.events).pipe(Effect.timeout("10 seconds")),
					);
					assert.instanceOf(
						stillDown,
						TransportError,
						"a fresh subscription before start is still the failed stream, not a live one",
					);

					// The way back in re-dials and reacquires the same session by id.
					const resumed = yield* owner.start({cwd, resume: started.sessionId});
					assert.strictEqual(resumed.sessionId, started.sessionId);
					yield* owner.prompt("second question");
					const after = yield* drain(owner);
					assert.isTrue(
						items(after).some((item) => item.kind === "user" && item.text === "first question"),
						"the reacquired session kept the transcript from before the drop",
					);
				}).pipe(
					Effect.provide(
						aiAgentOverClient({model: MODEL}).pipe(
							Layer.provide(PiClientService.layer({transportFactory: socket.factory})),
						),
					),
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);
});
