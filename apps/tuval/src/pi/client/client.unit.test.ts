import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
} from "@earendil-works/pi-client";
import type {ClientMessage, ServerMessage, SessionSnapshot} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Duration, Effect, type Exit, Option, Queue, Stream} from "effect";
import {TEARDOWN_CEILING} from "../teardown.ts";
import {Disconnected, SessionLocked, SessionNotFound} from "./errors.ts";
import {defaultAnswer, startProtocolServer} from "./fixtures.ts";
import {PiClientService} from "./PiClientService.ts";
import {connectionRefusalOf, sessionRefusalOf} from "./refusals.ts";
import {webSocketTransportFactory} from "./transport.ts";

/** Long enough for a hidden retry to have redialled, if the client held one. */
const SETTLE_MS = 200;

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
	if (exit._tag !== "Failure") throw new Error("expected a failure");
	return Option.getOrThrowWith(
		Cause.findErrorOption(exit.cause),
		() => new Error("expected a typed failure"),
	);
};

describe("folding PiClient's thrown values into the four refusals", () => {
	it("names the session when the pin refuses ownership", () => {
		const refusal = sessionRefusalOf(
			"s-1",
			new PiSessionOwnershipError("s-1", "Session s-1 already has an active lease"),
		);
		assert.instanceOf(refusal, SessionLocked);
	});

	it("reads session_locked and not_found off the protocol error", () => {
		const locked = sessionRefusalOf(
			"s-1",
			new PiServerError({code: "session_locked", message: "no"}),
		);
		const missing = sessionRefusalOf("s-2", new PiServerError({code: "not_found", message: "no"}));
		assert.instanceOf(locked, SessionLocked);
		assert.instanceOf(missing, SessionNotFound);
	});

	it("treats every way the connection ends as one Disconnected", () => {
		assert.instanceOf(connectionRefusalOf(new PiDisconnectedError()), Disconnected);
		assert.instanceOf(connectionRefusalOf(new PiClientDisposedError()), Disconnected);
		assert.instanceOf(sessionRefusalOf("s-1", new PiSessionDetachedError("s-1")), Disconnected);
	});

	it("folds an unrecognised value rather than letting it through", () => {
		const refusal = connectionRefusalOf("a string nobody typed");
		assert.strictEqual(refusal._tag, "tuval/pi/client/ProtocolRefused");
	});
});

const HELD = {id: "s-held", cwd: "/tuval/reacquire"} as const;

const heldSnapshot: SessionSnapshot = {
	id: HELD.id,
	cwd: HELD.cwd,
	createdAt: 0,
	updatedAt: 0,
	phase: "idle",
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision: 0,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
};

/**
 * A server that refuses the first `attempts` attaches with `session_locked` and then allows one —
 * the release of a replaced connection landing late, which is what the reacquire wait absorbs.
 */
const lockedUntil = (attempts: number) => {
	let seen = 0;
	return {
		attempts: () => seen,
		answer: (message: ClientMessage): ServerMessage | undefined => {
			if (message.type !== "request") return defaultAnswer(message);
			if (message.request.command === "create") {
				return {
					type: "response",
					id: message.id,
					ok: true,
					result: {command: "create", session: heldSnapshot},
				};
			}
			if (message.request.command !== "attach") return defaultAnswer(message);
			seen += 1;
			return seen <= attempts
				? {
						type: "response",
						id: message.id,
						ok: false,
						error: {
							code: "session_locked",
							message: `session ${HELD.id} is attached to another connection`,
							details: {sessionId: HELD.id},
						},
					}
				: {
						type: "response",
						id: message.id,
						ok: true,
						result: {command: "attach", session: heldSnapshot},
					};
		},
	};
};

describe("the PiClient lease service", () => {
	it.live("holds no retry loop: one drop, one Disconnected, no redial until asked", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			return yield* Effect.gen(function* () {
				const pi = yield* PiClientService;

				// Subscribed before the dial: `connect` suspends on real socket I/O, which is where
				// the forked stream registers its listener, so the drop below cannot outrun it.
				const drops = yield* Stream.toQueue(pi.disconnections, {capacity: "unbounded"});
				yield* pi.connect;
				assert.isTrue(yield* pi.connected);
				assert.strictEqual(server.connectionCount(), 1);

				server.dropAll();
				const dropped = yield* Queue.take(drops);
				assert.instanceOf(dropped, Disconnected);

				yield* Effect.sleep(`${SETTLE_MS} millis`);
				assert.isFalse(yield* pi.connected);
				assert.strictEqual(server.connectionCount(), 1);
				assert.isTrue(Option.isNone(yield* Queue.poll(drops)));

				// A call while disconnected is refused, not queued behind a redial.
				const exit = yield* Effect.exit(pi.createSession("/tmp"));
				assert.instanceOf(failureOf(exit), Disconnected);
				assert.strictEqual(server.connectionCount(), 1);

				// Only an explicit reconnect dials again.
				yield* pi.reconnect;
				assert.isTrue(yield* pi.connected);
				assert.strictEqual(server.connectionCount(), 2);
			}).pipe(Effect.provide(PiClientService.layerWebSocket({url: server.url})));
		}).pipe(Effect.scoped),
	);

	it.live("waits a reacquire out while the server still shows the replaced connection", () =>
		Effect.gen(function* () {
			// Two refusals, which the wait absorbs on its third try — the shape of a release still
			// in flight behind the socket this reacquire replaces.
			const attach = lockedUntil(2);
			const server = yield* startProtocolServer({answer: attach.answer});
			return yield* Effect.gen(function* () {
				const pi = yield* PiClientService;
				const drops = yield* Stream.toQueue(pi.disconnections, {capacity: "unbounded"});
				yield* pi.connect;
				yield* pi.createSession(HELD.cwd);

				server.dropAll();
				// The pin refuses `reconnect()` on a client that has not yet seen the drop, so the
				// re-dial waits on the notification rather than on the socket.
				yield* Queue.take(drops);
				yield* pi.reconnect;

				const reacquired = yield* pi.attachSession(HELD.id);
				assert.strictEqual(reacquired.id, HELD.id);
				assert.strictEqual(attach.attempts(), 3, "the reacquire retried the refusals it met");
			}).pipe(Effect.provide(PiClientService.layerWebSocket({url: server.url})));
		}).pipe(Effect.scoped),
	);

	it.live("refuses a session it never held on the first try, without waiting", () =>
		Effect.gen(function* () {
			const attach = lockedUntil(Number.POSITIVE_INFINITY);
			const server = yield* startProtocolServer({answer: attach.answer});
			return yield* Effect.gen(function* () {
				const pi = yield* PiClientService;
				yield* pi.connect;
				const exit = yield* Effect.exit(pi.attachSession(HELD.id));
				assert.instanceOf(failureOf(exit), SessionLocked);
				assert.strictEqual(attach.attempts(), 1, "a second claimant is refused, not waited out");
			}).pipe(Effect.provide(PiClientService.layerWebSocket({url: server.url})));
		}).pipe(Effect.scoped),
	);

	it.live("refuses a prompt on a session it holds no lease on", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			return yield* Effect.gen(function* () {
				const pi = yield* PiClientService;
				yield* pi.connect;
				const exit = yield* Effect.exit(pi.prompt("s-unknown", "hello"));
				assert.instanceOf(failureOf(exit), SessionNotFound);
			}).pipe(Effect.provide(PiClientService.layerWebSocket({url: server.url})));
		}).pipe(Effect.scoped),
	);
});

/**
 * `PiClient.dispose()` is not `async` at the 0.84.3 pin: its body rejects the pending requests,
 * calls `#connection.disconnect(error)` and disposes the state before the promise is returned
 * (`dist/client.js` line 292), and `disconnect` reaches `transport?.close()` with no try/catch
 * (`dist/connection.js` line 190). A transport whose `close()` throws therefore makes `dispose()`
 * throw synchronously — into an uninterruptible release, where an escaping throw would leave the
 * ceiling's timer armed and the stop never resumed.
 */
const closeThrows = (url: string): ByteTransportFactory => {
	const open = webSocketTransportFactory({url});
	return async (handlers) => {
		const transport = await open(handlers);
		return {
			send: (chunk) => transport.send(chunk),
			close: () => {
				transport.close();
				// biome-ignore lint/plugin: the throw is the subject under test — the pin's own `transport?.close()` call site has no try/catch, so this is how a real one lands.
				throw new Error("the transport refused to close");
			},
		};
	};
};

describe("the lease service's release", () => {
	it.live("returns when the client's dispose throws synchronously", () =>
		Effect.gen(function* () {
			const server = yield* startProtocolServer();
			const started = Date.now();
			yield* Effect.gen(function* () {
				const pi = yield* PiClientService;
				yield* pi.connect;
				assert.isTrue(yield* pi.connected);
			}).pipe(
				Effect.provide(PiClientService.layer({transportFactory: closeThrows(server.url)})),
				Effect.scoped,
			);
			assert.isBelow(
				Date.now() - started,
				Duration.toMillis(TEARDOWN_CEILING),
				"a throwing dispose left the release waiting out the ceiling instead of returning on it",
			);
		}).pipe(Effect.scoped),
	);
});
