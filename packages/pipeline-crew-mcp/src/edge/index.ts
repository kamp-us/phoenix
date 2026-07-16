/**
 * edge/ — the MCP channel edge: bridges the peer inbox to a Claude Code session over the
 * `claude/channel` capability. Generic (crew-agnostic); see the boundary note in
 * `../index.ts`.
 *
 * Two directions, wired to a peer at the crew root (#3059):
 *   - inbound  — `channelInboxLayer` is the peer's `Inbox`; each delivery `wake`s the
 *     session via the `ChannelSink` as a structured `<channel>` tag,
 *   - outbound — `channelServerLayer` serves the MCP server (capability + `channel_send`
 *     tool), routing sends through the `ChannelSend` port.
 */
export {channelInboxLayer, formatChannelTag} from "./bridge.ts";
export {ChannelSink} from "./channel-sink.ts";
export {
	CHANNEL_CAPABILITY,
	CHANNEL_NOTIFICATION_METHOD,
	type ChannelNotificationPayload,
	channelExperimentalCapability,
} from "./mcp-channel.ts";
export {ChannelSend, ChannelToolkit, channelToolHandlers, SendChannelMessage} from "./send-tool.ts";
export {channelServerLayer} from "./server.ts";
