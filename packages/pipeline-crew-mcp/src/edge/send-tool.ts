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
import {Messages} from "../protocol/index.ts";

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
	failure: PeerUnreachableError,
});

export const ChannelToolkit = Toolkit.make(SendChannelMessage);

/** The toolkit handler, routing each call through the `ChannelSend` port. */
export const channelToolHandlers = ChannelToolkit.toLayer(
	Effect.gen(function* () {
		const sender = yield* ChannelSend;
		return {
			channel_send: ({body, kind, targetRole}) => sender.send(targetRole, kind, body),
		};
	}),
);
