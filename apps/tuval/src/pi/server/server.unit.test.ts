import type {ProtocolError, ServerMessage, SessionSnapshot} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Redacted, type Scope} from "effect";
import {makeScriptedHost, type ScriptedHost} from "./fixtures.ts";
import {CLOSE_FRAME_TOO_LARGE, CLOSE_QUEUE_OVERFLOW} from "./limits.ts";
import {makeOutbound} from "./outbound.ts";
import {PiServerService} from "./PiServerService.ts";
import {connectWire, type WireClient} from "./wire-fixture.ts";

const isResponse = (id: string) => (message: ServerMessage) =>
	message.type === "response" && message.id === id;

const responseOf = (client: WireClient, id: string) =>
	client.next(isResponse(id)) as Effect.Effect<
		Extract<ServerMessage, {type: "response"}>,
		never,
		never
	>;

const okResult = (message: Extract<ServerMessage, {type: "response"}>) => {
	if (!message.ok) throw new Error(`expected ok, got ${message.error.code}`);
	return message.result;
};

const errorOf = (message: Extract<ServerMessage, {type: "response"}>): ProtocolError => {
	if (message.ok) throw new Error("expected a refusal");
	return message.error;
};

const sessionOf = (message: Extract<ServerMessage, {type: "response"}>): SessionSnapshot => {
	const result = okResult(message);
	if (result.command === "list" || result.command === "detach") {
		throw new Error(`${result.command} carries no session`);
	}
	return result.session;
};

const withServer = <A, E>(
	host: ScriptedHost,
	body: (server: PiServerService["Service"]) => Effect.Effect<A, E, Scope.Scope | PiServerService>,
	config: Parameters<typeof PiServerService.layer>[0] = {},
) =>
	Effect.gen(function* () {
		const server = yield* PiServerService;
		return yield* body(server);
	}).pipe(
		Effect.scoped,
		Effect.provide(PiServerService.layer(config).pipe(Layer.provide(host.layer))),
	);

const dial = (server: PiServerService["Service"], query = "") =>
	connectWire(`${Redacted.value(server.url)}${query}`);

const createSession = (client: WireClient, id: string, cwd = "/tmp/tuval-test") =>
	Effect.gen(function* () {
		yield* client.request(id, {command: "create", cwd});
		return sessionOf(yield* responseOf(client, id));
	});

describe("PiServerService", () => {
	it.live("binds loopback on an ephemeral port and greets with the server snapshot", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				assert.strictEqual(server.address.host, "127.0.0.1");
				assert.isAbove(server.address.port, 0);
				const client = yield* dial(server);
				const hello = yield* client.next((message) => message.type === "hello");
				assert.strictEqual(hello.type === "hello" ? hello.snapshot.models.length : 0, 1);
			}),
		);
	});

	it.live("answers each request under its own id, a later one first", () => {
		const host = makeScriptedHost({promptDelayMs: 120});
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const client = yield* dial(server);
				const session = yield* createSession(client, "r0");

				yield* client.request("slow", {
					command: "prompt",
					sessionId: session.id,
					text: "take your time",
				});
				yield* client.request("fast", {command: "list"});

				const fast = yield* responseOf(client, "fast");
				const order = client
					.received()
					.filter((message) => message.type === "response")
					.map((message) => message.id);
				assert.include(order, "fast");
				assert.notInclude(order, "slow");
				assert.strictEqual(okResult(fast).command, "list");

				const slow = yield* responseOf(client, "slow");
				assert.strictEqual(okResult(slow).command, "prompt");
			}),
		);
	});

	it.live("pushes a session snapshot per change, with advancing revisions", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const client = yield* dial(server);
				const session = yield* createSession(client, "r0");
				yield* client.request("p1", {command: "prompt", sessionId: session.id, text: "hi"});
				yield* responseOf(client, "p1");

				const pushed = yield* client.next(
					(message) =>
						message.type === "event" &&
						message.event.type === "session_snapshot" &&
						message.event.snapshot.revision >= 1,
				);
				const snapshot =
					pushed.type === "event" && pushed.event.type === "session_snapshot"
						? pushed.event.snapshot
						: undefined;
				assert.isDefined(snapshot);
				assert.isAtLeast(snapshot?.revision ?? 0, 1);
				assert.deepStrictEqual(
					(snapshot?.transcript ?? []).map((item) => item.role),
					["user", "assistant"],
				);
			}),
		);
	});

	it.live("refuses a second connection attaching an owned session", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const owner = yield* dial(server);
				const session = yield* createSession(owner, "r0");

				const intruder = yield* dial(server);
				yield* intruder.request("a1", {command: "attach", sessionId: session.id});
				assert.strictEqual(errorOf(yield* responseOf(intruder, "a1")).code, "session_locked");

				yield* intruder.request("p1", {
					command: "prompt",
					sessionId: session.id,
					text: "mine now",
				});
				assert.strictEqual(errorOf(yield* responseOf(intruder, "p1")).code, "session_locked");
			}),
		);
	});

	it.live("reconnects on the same connection: new lease, same transcript", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const client = yield* dial(server);
				const session = yield* createSession(client, "r0");
				yield* client.request("p1", {command: "prompt", sessionId: session.id, text: "hi"});
				const afterPrompt = sessionOf(yield* responseOf(client, "p1"));
				assert.strictEqual(afterPrompt.transcript.length, 2);

				yield* client.request("a1", {command: "attach", sessionId: session.id});
				const reacquired = sessionOf(yield* responseOf(client, "a1"));
				assert.isTrue(reacquired.attached);
				assert.isTrue(reacquired.locked);
				assert.deepStrictEqual(
					reacquired.transcript.map((item) => item.role),
					["user", "assistant"],
				);
			}),
		);
	});

	it.live("answers a missing session with a structured not_found", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const client = yield* dial(server);
				yield* client.next((message) => message.type === "hello");
				yield* client.request("a1", {command: "attach", sessionId: "no-such-session"});
				const error = errorOf(yield* responseOf(client, "a1"));
				assert.strictEqual(error.code, "not_found");
				assert.deepStrictEqual(error.details, {sessionId: "no-such-session"});
			}),
		);
	});

	it.live("closes a socket that sends a frame over the declared bound", () => {
		const host = makeScriptedHost();
		return withServer(
			host,
			(server) =>
				Effect.gen(function* () {
					const client = yield* dial(server);
					yield* client.next((message) => message.type === "hello");

					const oversized = new Uint8Array(8 + 4096);
					new DataView(oversized.buffer).setUint32(0, oversized.length - 4, false);
					yield* client.sendRaw(oversized);

					assert.strictEqual((yield* client.closure).code, CLOSE_FRAME_TOO_LARGE);
				}),
			{limits: {maxInboundFrameLength: 64}},
		);
	});

	it.live("refuses a bad token and a non-loopback Origin before any frame", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const wrongToken = yield* connectWire(
					`ws://127.0.0.1:${server.address.port}/?token=${"0".repeat(64)}`,
				);
				assert.include((yield* wrongToken.closure).reason, "401");

				const wrongOrigin = yield* connectWire(Redacted.value(server.url), {
					headers: {Origin: "https://example.com"},
				});
				assert.include((yield* wrongOrigin.closure).reason, "403");
			}),
		);
	});

	it.live("stays up when a Host passes the loopback check but does not parse", () => {
		const host = makeScriptedHost();
		return withServer(host, (server) =>
			Effect.gen(function* () {
				const malformed = yield* connectWire(`ws://127.0.0.1:${server.address.port}/`, {
					headers: {Host: "127.0.0.1:abc"},
				});
				assert.include((yield* malformed.closure).reason, "401");

				const client = yield* dial(server);
				yield* client.next((message) => message.type === "hello");
			}),
		);
	});

	it.live("closes every connection and disposes every session exactly once on scope close", () => {
		const host = makeScriptedHost();
		return Effect.gen(function* () {
			yield* withServer(host, (server) =>
				Effect.gen(function* () {
					const client = yield* dial(server);
					yield* createSession(client, "r0");
					yield* createSession(client, "r1");
					assert.strictEqual(yield* server.openSessions, 2);
				}),
			);
			assert.deepStrictEqual([...host.disposals.values()], [1, 1]);
		});
	});
});

describe("outbound", () => {
	it.effect("refuses a frame over its bound instead of growing", () =>
		Effect.gen(function* () {
			const outbound = yield* makeOutbound({
				capacity: 2,
				send: () => Effect.never,
			});
			assert.isTrue(outbound.offer(new Uint8Array([1])));
			assert.isTrue(outbound.offer(new Uint8Array([2])));
			assert.isFalse(outbound.offer(new Uint8Array([3])));
			assert.strictEqual(outbound.pending(), 2);
		}),
	);

	it("names a close code for the overflow", () => {
		assert.strictEqual(CLOSE_QUEUE_OVERFLOW, 1013);
	});
});
