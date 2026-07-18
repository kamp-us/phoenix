/**
 * Inbound bridge behavior (AC 2): a delivery to the channel-bridging `Inbox` wakes the
 * session over the `ChannelSink`, carrying the message as a structured `<channel>` tag with
 * the sender in `meta.from`, and returns a delivered-to-inbox ack stamped by this edge peer.
 * Driven against a capturing `ChannelSink`, so the bridge logic is under test without a live
 * MCP transport (the real emit-through-the-patched-notification path is `channel-sink.test.ts`).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref} from "effect";
import {Inbox, type InboxEnvelope} from "../peer/index.ts";
import {channelInboxLayer, formatChannelTag} from "./bridge.ts";
import {ChannelSink} from "./channel-sink.ts";
import type {ChannelNotificationPayload} from "./mcp-channel.ts";

const envelope = (over?: Partial<InboxEnvelope>): InboxEnvelope => ({
	messageId: "msg-1",
	from: "peer-a",
	kind: "IntakePing",
	body: {issue: "3057"},
	at: "2026-07-16T10:00:00Z",
	...over,
});

describe("edge/bridge — inbound peer-inbox message wakes the session (AC2)", () => {
	it.effect("a delivery emits a channel wake with the message as a <channel> tag", () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<ChannelNotificationPayload>>([]);
			const CapturingSink = Layer.succeed(ChannelSink, {
				wake: (payload) => Ref.update(captured, (xs) => [...xs, payload]),
			});

			yield* Effect.gen(function* () {
				const inbox = yield* Inbox;
				const ack = yield* inbox.deliver(envelope({messageId: "m-7"}));
				// delivered-to-inbox, stamped by this edge peer — never seen-by-model (#3035).
				assert.strictEqual(ack.messageId, "m-7");
				assert.strictEqual(ack.by, "edge-a");

				const wakes = yield* Ref.get(captured);
				assert.strictEqual(wakes.length, 1);
				assert.strictEqual(wakes[0]?.content, formatChannelTag(envelope({messageId: "m-7"})));
				assert.strictEqual(wakes[0]?.meta?.from, "peer-a");
			}).pipe(Effect.provide(channelInboxLayer("edge-a").pipe(Layer.provide(CapturingSink))));
		}),
	);

	it("formatChannelTag renders sender + kind as attributes and the body as content", () => {
		const tag = formatChannelTag(envelope());
		assert.match(tag, /^<channel from="peer-a" kind="IntakePing">/);
		assert.include(tag, '{"issue":"3057"}');
	});
});
