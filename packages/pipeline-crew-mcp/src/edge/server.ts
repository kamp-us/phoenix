/**
 * edge/server — the channel-serving MCP server a crew session loads over stdio: it
 * advertises the `claude/channel` capability and registers the outbound send tool.
 * Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * Load path: a session starts Claude Code with `--dangerously-load-development-channels`
 * (research preview) and this server as a stdio MCP server. The inbound wake path is the
 * `channelInboxLayer` bridge (`./bridge.ts`), wired to the peer inbox at the crew root
 * (#3059) — this layer requires the `ChannelSend` port (the peer's send capability) and
 * the `Stdio` transport env, both supplied there.
 */
import {Layer} from "effect";
import {McpServer} from "effect/unstable/ai";
import {channelExperimentalCapability} from "./mcp-channel.ts";
import {ChannelToolkit, channelToolHandlers} from "./send-tool.ts";

export const channelServerLayer = (options: {readonly name: string; readonly version: string}) =>
	McpServer.toolkit(ChannelToolkit).pipe(
		Layer.provide(channelToolHandlers),
		Layer.provide(
			McpServer.layerStdio({
				name: options.name,
				version: options.version,
				experimental: channelExperimentalCapability,
			}),
		),
	);
