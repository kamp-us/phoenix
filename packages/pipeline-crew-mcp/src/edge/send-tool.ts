/**
 * edge/send-tool — the outbound half of the channel edge: an MCP tool a session calls to
 * send a typed message to a role, routed through the peer dialer (tracker lookup + dial +
 * inbox-ack). Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The tool wraps the `ChannelSend` port — the peer's `send` capability (`../peer`) — so the
 * edge never constructs a peer (the crew composition root does, #3059). A send to an
 * offline role surfaces as `PeerUnreachableError`, which the tool returns as an error result
 * to the caller — never a silent drop (#3035).
 */
import {Context, Effect, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";
import {type InboxAck, PeerUnreachableError} from "../peer/index.ts";
import {crewMessageKinds, Messages, payloadSchemaForKind} from "../protocol/index.ts";

/**
 * A message rejected at the wire because its shape doesn't match the catalog: an unknown
 * `kind` (not one of the 7 catalog kinds) or a `body` that fails that kind's payload schema.
 * The gate that makes the typed catalog an invariant, not advice (#3229) — the sender gets
 * this typed reject instead of a delivered-to-inbox ack, so a wrong shape never reaches a peer.
 */
export class InvalidMessageError extends Schema.TaggedErrorClass<InvalidMessageError>()(
	"@kampus/pipeline-crew-mcp/InvalidMessageError",
	{
		kind: Schema.String,
		reason: Schema.String,
	},
) {}

/** The outbound send capability: dial the live peer serving `targetRole` and deliver `kind`/`body`. */
export class ChannelSend extends Context.Service<
	ChannelSend,
	{
		readonly send: (
			targetRole: string,
			kind: string,
			body: unknown,
		) => Effect.Effect<InboxAck, PeerUnreachableError>;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelSend") {}

/**
 * Decode `body` against the catalog schema for `kind` before anything is dialed. An unknown
 * kind or a body that fails its kind's schema short-circuits with an `InvalidMessageError`, so
 * the send never reaches `ChannelSend.send` and the sender never sees a delivered-to-inbox ack
 * for a malformed message (#3229). A valid body passes through unchanged.
 */
const validateOutbound = (
	kind: string,
	body: unknown,
): Effect.Effect<void, InvalidMessageError> => {
	const schema = payloadSchemaForKind(kind);
	if (schema === undefined) {
		return Effect.fail(
			new InvalidMessageError({
				kind,
				reason: `unknown kind — not one of the catalog kinds: ${crewMessageKinds.join(", ")}`,
			}),
		);
	}
	return Schema.decodeUnknownEffect(schema)(body).pipe(
		Effect.asVoid,
		Effect.mapError(
			(error) =>
				new InvalidMessageError({
					kind,
					reason: `body does not match the "${kind}" schema: ${error}`,
				}),
		),
	);
};

/** The one send tool: `{targetRole, kind, body}` in, the delivered-to-inbox ack out. */
export const SendChannelMessage = Tool.make("channel_send", {
	description:
		"Send a typed message to the live peer serving a role; returns the delivered-to-inbox ack.",
	parameters: Schema.Struct({
		targetRole: Schema.NonEmptyString,
		kind: Schema.NonEmptyString,
		body: Schema.Unknown,
	}),
	success: Messages.InboxAck,
	failure: Schema.Union([PeerUnreachableError, InvalidMessageError]),
});

export const ChannelToolkit = Toolkit.make(SendChannelMessage);

/** The toolkit handler: validate the message shape, then route the send through the `ChannelSend` port. */
export const channelToolHandlers = ChannelToolkit.toLayer(
	Effect.gen(function* () {
		const sender = yield* ChannelSend;
		return {
			channel_send: ({body, kind, targetRole}) =>
				validateOutbound(kind, body).pipe(Effect.andThen(sender.send(targetRole, kind, body))),
		};
	}),
);
