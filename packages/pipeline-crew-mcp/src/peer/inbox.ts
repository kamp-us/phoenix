/**
 * peer/inbox — the receiving half of a session-edge peer: the typed inbox contract (an
 * `RpcGroup` an `RpcServer` serves) plus the `Inbox` service that records deliveries and
 * returns an inbox-ack. Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The one non-obvious thing: a successful `Deliver` reply is an `InboxAck`, and that ack
 * means exactly delivered-to-peer-inbox — the reception guarantee capture-pane verification
 * used to fake (locked in #3035), never seen-by-model. `InboxAck` is the peer data plane's
 * own ack (the crew message catalog carries no ack kind — nothing sends one, #3302); it and
 * the envelope are built from the `protocol/` field primitives (`MessageId`/`PeerId`/…).
 */
import {Context, Effect, Layer, Ref, Schema} from "effect";
import {Rpc, RpcGroup} from "effect/unstable/rpc";
import {Messages} from "../protocol/index.ts";

/** A dialable inbox address — opaque to the peer (a socket path, URL, …), resolved via the tracker. */
export const PeerAddress = Schema.NonEmptyString;

/**
 * One delivered message on the wire: the correlating id, the sender, the catalog kind
 * name, and the kind's payload. `body` is `Unknown` so the inbox carries any catalog kind
 * generically — the receiving app decodes it against the `protocol/` schema for `kind`,
 * which is what keeps peer/ free of any per-kind (and so any crew) coupling.
 */
export const InboxEnvelope = Schema.Struct({
	messageId: Messages.MessageId,
	from: Messages.PeerId,
	kind: Schema.NonEmptyString,
	body: Schema.Unknown,
	at: Messages.Timestamp,
});
export type InboxEnvelope = typeof InboxEnvelope.Type;

/**
 * The delivered-to-inbox ack: the receiving peer (`by`) echoes the delivery's `messageId` so
 * the sender can correlate the ack to its send. This is the peer data plane's own reply shape,
 * not a crew message catalog kind — the catalog has no ack kind because nothing sends one (#3302).
 */
export const InboxAck = Schema.Struct({
	messageId: Messages.MessageId,
	by: Messages.PeerId,
	at: Messages.Timestamp,
});
export type InboxAck = typeof InboxAck.Type;

/** Deliver one message to this peer's inbox; the reply is the delivered-to-inbox ack. */
export const Deliver = Rpc.make("Deliver", {
	payload: InboxEnvelope,
	success: InboxAck,
});

/** The peer inbox contract — the one `RpcGroup` an inbox `RpcServer` serves and a dialer speaks. */
export const PeerInbox = RpcGroup.make(Deliver);

/**
 * A peer's inbox: the delivery handler that acks + the log of what landed. `deliver`
 * stamps the ack with this peer's own id (`by`) and echoes the envelope's `messageId`,
 * so the sender can correlate the ack to its send.
 */
export class Inbox extends Context.Service<
	Inbox,
	{
		readonly deliver: (envelope: InboxEnvelope) => Effect.Effect<InboxAck>;
		readonly received: Effect.Effect<ReadonlyArray<InboxEnvelope>>;
	}
>()("@kampus/pipeline-crew-mcp/peer/Inbox") {
	/** Build an inbox owned by peer `self`; deliveries are recorded and acked as delivered-to-inbox. */
	static readonly layer = (self: string): Layer.Layer<Inbox> =>
		Layer.effect(
			Inbox,
			Effect.gen(function* () {
				const log = yield* Ref.make<ReadonlyArray<InboxEnvelope>>([]);
				return {
					deliver: (envelope) =>
						Ref.update(log, (xs) => [...xs, envelope]).pipe(
							Effect.as({
								messageId: envelope.messageId,
								by: self,
								at: new Date().toISOString(),
							}),
						),
					received: Ref.get(log),
				};
			}),
		);
}

/** The `PeerInbox` handler layer, wired to whatever `Inbox` is in context. */
export const inboxHandlers = PeerInbox.toLayer(
	Effect.gen(function* () {
		const inbox = yield* Inbox;
		return {Deliver: inbox.deliver};
	}),
);
