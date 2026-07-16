/**
 * Channel-sink emit against the patched base (AC 2): `layerFromMcpServer.wake` enqueues a
 * `notifications/claude/channel` request onto the running `McpServer`'s outgoing-notification
 * queue, carrying the `{message, _meta.from}` payload. The notification method is a
 * `ServerNotificationRpcs` member ONLY under the effect patch (ADR 0038) — so emitting it
 * through a real `McpServer` pins the bridge's last-mile emit to the actual patched wire
 * contract, not a stub. No transport is installed, so the queue isn't drained and the emitted
 * request is observable directly.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Queue} from "effect";
import {McpServer} from "effect/unstable/ai";
import {ChannelSink} from "./channel-sink.ts";
import {CHANNEL_NOTIFICATION_METHOD} from "./mcp-channel.ts";

// A live (transport-less) McpServer service — enough to observe its notification queue.
const TestServer = Layer.effect(McpServer.McpServer, McpServer.McpServer.make);

describe("edge/channel-sink — wake emits notifications/claude/channel (AC2, patched base)", () => {
	it.effect("a wake enqueues a claude/channel notification carrying the payload", () =>
		Effect.gen(function* () {
			const message = '<channel from="peer-a" kind="IntakePing">{}</channel>';
			const sink = yield* ChannelSink;
			yield* sink.wake({message, _meta: {from: "peer-a"}});

			const server = yield* McpServer.McpServer;
			const request = yield* Queue.take(server.notificationsQueue);
			assert.strictEqual(request.tag, CHANNEL_NOTIFICATION_METHOD);
			const payload = request.payload as {message: string; _meta?: {from?: string}};
			assert.strictEqual(payload.message, message);
			assert.strictEqual(payload._meta?.from, "peer-a");
		}).pipe(Effect.provide(ChannelSink.layerFromMcpServer.pipe(Layer.provideMerge(TestServer)))),
	);
});
