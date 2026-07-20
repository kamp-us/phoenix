/**
 * edge/ — the MCP channel edge: bridges the peer inbox to a Claude Code session over the
 * `claude/channel` capability. Generic (crew-agnostic); see the boundary note in
 * `../index.ts`.
 *
 * Two directions, wired to a peer at the crew root (#3059):
 *   - inbound  — `channelInboxLayer` is the peer's `Inbox`; each delivery `wake`s the
 *     session via the `ChannelSink` as a structured `<channel>` tag,
 *   - outbound — `channelServerLayer` serves the MCP server (capability + the `channel_send`
 *     relay tool + the `channel_claim` deconfliction tool), routing sends through the
 *     `ChannelSend` port and resource claims through the `ChannelClaim` port.
 */
export {channelInboxLayer, formatChannelTag} from "./bridge.ts";
export {ChannelSink} from "./channel-sink.ts";
export {
	ChannelClaim,
	type ClaimReply,
	ClaimResource,
	ClaimToolkit,
	claimToolHandlers,
} from "./claim-tool.ts";
export {
	ChannelContractView,
	ChannelDescribe,
	DescribeChannelKinds,
	KindsToolkit,
	kindsToolHandlers,
} from "./kinds-tool.ts";
export {
	CHANNEL_CAPABILITY,
	CHANNEL_NOTIFICATION_METHOD,
	type ChannelNotificationPayload,
	channelExperimentalCapability,
} from "./mcp-channel.ts";
export {
	ChannelSend,
	ChannelToolkit,
	channelToolHandlers,
	InvalidMessageError,
	SendChannelMessage,
} from "./send-tool.ts";
export {channelServerLayer} from "./server.ts";
