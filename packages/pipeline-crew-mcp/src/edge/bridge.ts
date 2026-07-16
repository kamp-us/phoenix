/**
 * edge/bridge — the inbound half of the channel edge: a peer-inbox delivery becomes a
 * `notifications/claude/channel` wake carrying the message as a structured `<channel>`
 * tag. Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The bridge IS the peer's `Inbox` service (`../peer`), so the peer inbox `RpcServer` fans
 * a `Deliver` straight into a channel wake — no second delivery path. It emits through the
 * `ChannelSink` port (`./channel-sink.ts`). The channel is 1:1 / wake-only / ack-less
 * (`.patterns/mcp-channel-contract.md`), so this does last-mile delivery only; addressing
 * and acks live in tracker/peer.
 */
import {Effect, Layer, Ref} from "effect";
import {Inbox, type InboxAck, type InboxEnvelope} from "../peer/index.ts";
import {ChannelSink} from "./channel-sink.ts";

/**
 * Render a delivered envelope as the `<channel>` tag the session reads: `from`/`kind` as
 * attributes, the body as content. Identity rides in the tag because the channel carries
 * no addressing (`_meta.from` on the notification is the wire-level echo of the same).
 */
export const formatChannelTag = (envelope: InboxEnvelope): string =>
	`<channel from=${JSON.stringify(envelope.from)} kind=${JSON.stringify(envelope.kind)}>${JSON.stringify(envelope.body)}</channel>`;

/**
 * A channel-bridging `Inbox`: every delivery wakes the session over the `ChannelSink` and
 * is recorded for `received`. The ack is stamped `by: self` — delivered-to-inbox, the peer
 * inbox contract (#3035); it never means seen-by-model (the channel has no delivery acks).
 */
export const channelInboxLayer = (self: string): Layer.Layer<Inbox, never, ChannelSink> =>
	Layer.effect(
		Inbox,
		Effect.gen(function* () {
			const sink = yield* ChannelSink;
			const log = yield* Ref.make<ReadonlyArray<InboxEnvelope>>([]);
			return {
				deliver: (envelope) =>
					sink.wake({message: formatChannelTag(envelope), _meta: {from: envelope.from}}).pipe(
						Effect.andThen(Ref.update(log, (xs) => [...xs, envelope])),
						Effect.as<InboxAck>({
							messageId: envelope.messageId,
							by: self,
							at: new Date().toISOString(),
						}),
					),
				received: Ref.get(log),
			};
		}),
	);
