/**
 * The client half of the vertical proof: the `PiClientService` dialling the real loopback
 * `PiServerService` (#7567) over a real `AgentSession` on Pi's own faux provider, so the run costs
 * nothing and calls no model API.
 *
 * The transport factory is wrapped so a test can hold the live transport and close it. Closing the
 * transport is what a dropped socket does to this client — `connection.js` turns the terminal
 * handler into a `disconnected` state change either way — and it is the only handle a test has on a
 * socket the server owns.
 */

import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage, fauxProvider} from "@earendil-works/pi-ai";
import type {ByteTransport, ByteTransportFactory} from "@earendil-works/pi-client";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Queue, Redacted, Stream} from "effect";
import {agentSessionHostLayer, PiServerService, SessionOpenFailed} from "../server/index.ts";
import {Disconnected, SessionLocked, SessionNotFound} from "./errors.ts";
import {PiClientService} from "./PiClientService.ts";
import {webSocketTransportFactory} from "./transport.ts";

const MODEL = {provider: "faux", id: "faux-1"} as const;

const setUp = () => {
	const cwd = mkdtempSync(join(tmpdir(), "tuval-pi-client-"));
	const faux = fauxProvider({
		provider: MODEL.provider,
		api: "faux",
		models: [{id: MODEL.id, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
	});
	faux.setResponses([fauxAssistantMessage("hello from faux"), fauxAssistantMessage("and again")]);
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

/** A factory that records the transport it last handed `PiClient`, so a test can drop it. */
const droppable = (url: string): {factory: ByteTransportFactory; drop: () => void} => {
	const open = webSocketTransportFactory({url});
	let live: ByteTransport | undefined;
	return {
		factory: async (handlers) => {
			const transport = await open(handlers);
			live = transport;
			return transport;
		},
		drop: () => live?.close(),
	};
};

describe("the PiClient lease service against the loopback server", () => {
	it.live(
		"refuses a second client's attach with SessionLocked, and a missing id with SessionNotFound",
		() => {
			const {cwd, faux} = setUp();
			return Effect.gen(function* () {
				const server = yield* PiServerService;
				const url = Redacted.value(server.url);

				// The owner's layer wraps the intruder's, so both connections are live at once —
				// the lock is the owner's *open* connection, not a record it leaves behind.
				yield* Effect.gen(function* () {
					const owner = yield* PiClientService;
					yield* owner.connect;
					const session = yield* owner.createSession(cwd, {model: MODEL});
					assert.strictEqual(session.cwd, cwd);

					yield* Effect.gen(function* () {
						const intruder = yield* PiClientService;
						yield* intruder.connect;

						const locked = yield* Effect.flip(intruder.attachSession(session.id));
						assert.instanceOf(locked, SessionLocked);

						const missing = yield* Effect.flip(intruder.attachSession("no-such-session"));
						assert.instanceOf(missing, SessionNotFound);
					}).pipe(Effect.provide(PiClientService.layerWebSocket({url})));
				}).pipe(Effect.provide(PiClientService.layerWebSocket({url})));
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);

	it.live(
		"reacquires by session id after a drop, and the reacquired snapshot retains the transcript",
		() => {
			const {cwd, faux} = setUp();
			return Effect.gen(function* () {
				const server = yield* PiServerService;
				const socket = droppable(Redacted.value(server.url));

				yield* Effect.gen(function* () {
					const pi = yield* PiClientService;
					yield* pi.connect;

					const session = yield* pi.createSession(cwd, {model: MODEL});
					const pushed = yield* Stream.toQueue(pi.snapshots(session.id), {
						capacity: "unbounded",
					});

					const prompted = yield* pi.prompt(session.id, "say hello");
					assert.deepStrictEqual(
						prompted.transcript.map((item) => item.role),
						["user", "assistant"],
					);

					// The server pushes the session's own snapshots to the connection that owns it,
					// and `snapshots` is the stream the handlers turn into a Sub.
					const first = yield* Queue.take(pushed);
					assert.strictEqual(first.id, session.id);

					socket.drop();
					const failed = yield* Effect.flip(pi.prompt(session.id, "into the void"));
					assert.instanceOf(failed, Disconnected);

					// Explicit, and the lease from before is gone: reconnect, then reacquire by id.
					yield* pi.reconnect;
					const reacquired = yield* pi.attachSession(session.id);
					assert.strictEqual(reacquired.id, session.id);

					const after = yield* pi.prompt(session.id, "say it again");
					assert.deepStrictEqual(
						after.transcript.map((item) => item.role),
						["user", "assistant", "user", "assistant"],
					);
					assert.include(
						JSON.stringify(after.transcript),
						"say hello",
						"the reacquired session kept the transcript from before the drop",
					);
				}).pipe(Effect.provide(PiClientService.layer({transportFactory: socket.factory})));

				assert.strictEqual(faux.state.callCount, 2);
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);
});
