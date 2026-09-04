import type {ByteTransport, ByteTransportHandlers} from "@earendil-works/pi-client";
import {
	type ClientMessage,
	encodeClientMessage,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Queue, type Scope} from "effect";
import {startProtocolServer} from "./fixtures.ts";
import {connectionRefusalOf} from "./refusals.ts";
import {webSocketTransportFactory} from "./transport.ts";

/** Long enough for a second terminal to have arrived if the transport were going to raise one. */
const SETTLE_MS = 100;

const requestFrame = (id: string): Uint8Array =>
	encodeClientMessage({type: "request", id, request: {command: "list"}});

const responseIdOf = (message: ServerMessage): string => {
	if (message.type !== "response") throw new Error(`expected a response, got ${message.type}`);
	return message.id;
};

const requestIdOf = (message: ClientMessage): string => {
	if (message.type !== "request") throw new Error(`expected a request, got ${message.type}`);
	return message.id;
};

interface Dialed {
	readonly transport: ByteTransport;
	readonly inbox: Queue.Dequeue<ServerMessage>;
	readonly terminals: Queue.Dequeue<string>;
}

/** Opens one transport, decoding what arrives with the protocol's own decoder. */
const dial = (url: string): Effect.Effect<Dialed, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const decoder = new ServerMessageDecoder();
		const inbox = yield* Queue.unbounded<ServerMessage>();
		const terminals = yield* Queue.unbounded<string>();
		const handlers: ByteTransportHandlers = {
			onData: (chunk) => {
				for (const message of decoder.push(chunk)) Queue.offerUnsafe(inbox, message);
			},
			onClose: () => {
				Queue.offerUnsafe(terminals, "close");
			},
			onError: (error) => {
				Queue.offerUnsafe(terminals, `error: ${error.message}`);
			},
		};
		const transport = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => webSocketTransportFactory({url})(handlers),
				catch: connectionRefusalOf,
			}),
			(open) => Effect.sync(() => open.close()),
		);
		return {transport, inbox, terminals};
	});

describe("the WebSocket ByteTransport", () => {
	it.live("sends and receives binary frames in order", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			const {transport, inbox, terminals} = yield* dial(server.url);

			const ids = Array.from({length: 16}, (_, index) => `frame-${index}`);
			// Every `send` is invoked before any of them is awaited, so the order under test is
			// invocation order and not an order the test serialised into place.
			const sends = ids.map((id) => transport.send(requestFrame(id)));
			yield* Effect.tryPromise({try: () => Promise.all(sends), catch: connectionRefusalOf});

			const answered = yield* Effect.forEach(ids, () => Queue.take(inbox), {concurrency: 1});

			assert.deepStrictEqual(answered.map(responseIdOf), ids);
			assert.deepStrictEqual(server.received().map(requestIdOf), ids);
			assert.isTrue(Option.isNone(yield* Queue.poll(terminals)));
		}).pipe(Effect.scoped),
	);

	it.live("refuses a send once closed, and raises no terminal for its own close", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			const {transport, terminals} = yield* dial(server.url);

			yield* Effect.tryPromise({
				try: () => transport.send(requestFrame("before-close")),
				catch: connectionRefusalOf,
			});
			transport.close();
			// Repeated closes are harmless, which the `ByteTransport` contract requires.
			transport.close();

			const exit = yield* Effect.exit(
				Effect.tryPromise({
					try: () => transport.send(requestFrame("after-close")),
					catch: connectionRefusalOf,
				}),
			);
			assert.isTrue(exit._tag === "Failure");

			yield* Effect.sleep(`${SETTLE_MS} millis`);
			assert.isTrue(Option.isNone(yield* Queue.poll(terminals)));
		}).pipe(Effect.scoped),
	);

	it.live("reports a drop as exactly one terminal", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			const {transport, inbox, terminals} = yield* dial(server.url);

			yield* Effect.tryPromise({
				try: () => transport.send(requestFrame("alive")),
				catch: connectionRefusalOf,
			});
			yield* Queue.take(inbox);
			server.dropAll();

			yield* Queue.take(terminals);
			yield* Effect.sleep(`${SETTLE_MS} millis`);
			assert.isTrue(Option.isNone(yield* Queue.poll(terminals)));
		}).pipe(Effect.scoped),
	);

	it.live("fails the factory's promise when the dial never connects", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(dial("ws://127.0.0.1:1/"));
			assert.isTrue(exit._tag === "Failure");
		}).pipe(Effect.scoped),
	);

	it("refuses options it cannot dial with", () => {
		assert.throws(() => webSocketTransportFactory({url: "not-a-url"}), TypeError);
		assert.throws(
			() => webSocketTransportFactory({url: "ws://127.0.0.1:1/", maxPendingBytes: 0}),
			TypeError,
		);
	});
});
