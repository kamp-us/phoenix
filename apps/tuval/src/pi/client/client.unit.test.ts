import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
} from "@earendil-works/pi-client";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, type Exit, Option, Queue, Stream} from "effect";
import {Disconnected, SessionLocked, SessionNotFound} from "./errors.ts";
import {startProtocolServer} from "./fixtures.ts";
import {PiClientService} from "./PiClientService.ts";
import {connectionRefusalOf, sessionRefusalOf} from "./refusals.ts";

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
