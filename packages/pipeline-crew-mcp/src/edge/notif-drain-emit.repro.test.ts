// @patch-pin: effect@4.0.0-beta.92
/**
 * Behavior pin for the (#3499) hunk of `patches/effect@4.0.0-beta.92.patch` (ADR 0038): the McpServer
 * notification-routing branch arms `server.initializedClients` when a client sends
 * `notifications/initialized` — the Set the run-loop notification drain gates every server->client
 * notification on.
 *
 * The 0-delivery defect: `server.initializedClients` is otherwise NEVER populated (two compounding
 * upstream bugs — the `notifications/initialized` handler is a no-op AND is unreachable, since the
 * router dispatches client notifications by `handlers.mapUnsafe.get(request.tag)` but handlers are
 * keyed by `rpc.key` = `effect/rpc/Rpc/<tag>`, so the bare-tag lookup always misses). The drain's
 * `for (const clientId of server.initializedClients.keys())` then iterates an empty Set and emits
 * nothing — a channel wake (and `tools/list_changed`) is dequeued and dropped, so the recipient client
 * gets 0 tokens despite the InboxAck (which returns on enqueue, not emit). The fix arms the gate at
 * the routing point with the same numeric `clientId` the drain iterates; the client sends
 * `notifications/initialized` after the initialize response per the MCP lifecycle (claude-code
 * v2.1.214's client does — its handshake ends `await this.notification({method:"notifications/initialized"})`).
 *
 * Faithful LIVE-path pin: boots the real `McpServer.layerStdio` (the exact transport `bin.ts session`
 * serves) over a fake Stdio, feeds a raw NDJSON-RPC `initialize` + `notifications/initialized` into
 * stdin, fires a `notifications/claude/channel` wake through the running server, and asserts the wire
 * line reaches stdout. RED on current effect (empty Set ⇒ no line), GREEN on the fix. A SECOND wake to
 * the same client must ALSO emit — the drain only `.delete()`s a member once it leaves the live
 * `clientIds` (disconnect), never after a send, so an armed client keeps receiving. `it.live` (not
 * `it.effect`): the forked run-loop + stdin/stdout streaming turn on REAL async scheduling, not the
 * TestClock. Retire when effect ships a populated initialized-clients set and the patch is removed.
 */
import {assert, describe, it} from "@effect/vitest";
import {Deferred, Effect, Layer, Ref, Sink, Stdio, Stream} from "effect";
import {McpServer} from "effect/unstable/ai";
import {CHANNEL_NOTIFICATION_METHOD, channelExperimentalCapability} from "./mcp-channel.ts";

const decoder = new TextDecoder();
const ndjson = (message: unknown): Uint8Array =>
	new TextEncoder().encode(`${JSON.stringify(message)}\n`);

// The client handshake pair, in stdin order: the server processes `initialize` (storing the client
// session) before `notifications/initialized` (which the fix uses to arm the drain gate).
const INITIALIZE = ndjson({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "9999-01-01",
		capabilities: {},
		clientInfo: {name: "TestClient", version: "0.0.0"},
	},
});
const INITIALIZED = ndjson({jsonrpc: "2.0", method: "notifications/initialized"});

describe("effect McpServer drain patch (#3499) — a wake reaches an initialized client", () => {
	it.live(
		"after initialize + notifications/initialized, a channel wake emits to stdout — and a second wake to the same client also emits",
		() =>
			Effect.gen(function* () {
				const out = yield* Ref.make("");
				const stdin = Stream.fromIterable([INITIALIZE, INITIALIZED]).pipe(
					Stream.concat(Stream.never),
				);
				// biome-ignore lint/suspicious/useIterableCallbackReturn: Sink.forEach's callback returns an Effect (the per-chunk write), not an Array.forEach callback.
				const capturingStdout = Sink.forEach((chunk: string | Uint8Array) =>
					Ref.update(
						out,
						(acc) => acc + (typeof chunk === "string" ? chunk : decoder.decode(chunk)),
					),
				);

				// Launch the live stdio server on a forked scoped fiber (so a teardown interrupt never fails
				// the test body) and hand a `wake` closure out through a Deferred — resolved inside the layer
				// where `McpServer` is in scope — so the body fires wakes against the same running instance the
				// transport serves.
				const ready = yield* Deferred.make<(content: string) => Effect.Effect<void>>();
				const serverLayer = Layer.effectDiscard(
					Effect.flatMap(McpServer.McpServer, (server) =>
						Deferred.succeed(ready, (content: string) =>
							server.notifications[CHANNEL_NOTIFICATION_METHOD]({content}).pipe(Effect.asVoid),
						),
					),
				).pipe(
					Layer.provideMerge(
						McpServer.layerStdio({
							name: "DrainReproServer",
							version: "0.0.0",
							experimental: channelExperimentalCapability,
						}),
					),
					Layer.provide(Stdio.layerTest({stdin, stdout: () => capturingStdout})),
				);
				yield* Effect.forkScoped(Layer.launch(serverLayer));
				const wake = yield* Deferred.await(ready);

				// Let the forked run-loop consume the handshake pair so `initializedClients` is armed BEFORE
				// the wake enqueues — a wake drained before the client registers is lost (that is the bug, not
				// a race in the fix). A generous fixed window, since polling the Set would deadlock the RED run
				// (on the unfixed router it never populates).
				yield* Effect.sleep("1 second");

				yield* wake("wake-1");
				yield* Effect.sleep("500 millis");
				const afterFirst = yield* Ref.get(out);
				assert.include(
					afterFirst,
					CHANNEL_NOTIFICATION_METHOD,
					"the wake must be emitted to the initialized client — an empty initializedClients Set drops it (0 tokens)",
				);
				assert.include(
					afterFirst,
					"wake-1",
					"the emitted notification must carry the wake content",
				);

				yield* wake("wake-2");
				yield* Effect.sleep("500 millis");
				const afterSecond = yield* Ref.get(out);
				assert.include(
					afterSecond,
					"wake-2",
					"a SECOND wake to the same client must ALSO emit — the drain must not drop a client after one send",
				);
			}).pipe(Effect.scoped),
		{timeout: 20000},
	);
});
