/**
 * edge/channel-sink — the last-mile wake port: emit a `notifications/claude/channel` into
 * the connected session. Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * `ChannelSink` is the seam the inbox→channel bridge (`./bridge.ts`) delivers through, so
 * the bridge logic is testable without a live MCP transport. `layerFromMcpServer` is the
 * real implementation, emitting over the patched `notifications/claude/channel` member —
 * which exists only under the effect patch (`.patterns/mcp-channel-contract.md`), so the
 * wake is inert at a pin whose `patch-guard` is red.
 */
import {Context, Effect, Layer} from "effect";
import {McpServer} from "effect/unstable/ai";
import {CHANNEL_NOTIFICATION_METHOD, type ChannelNotificationPayload} from "./mcp-channel.ts";

export class ChannelSink extends Context.Service<
	ChannelSink,
	{
		readonly wake: (payload: ChannelNotificationPayload) => Effect.Effect<void>;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelSink") {
	/** Emit the wake through the running `McpServer`'s notification client. */
	static readonly layerFromMcpServer: Layer.Layer<ChannelSink, never, McpServer.McpServer> =
		Layer.effect(
			ChannelSink,
			Effect.gen(function* () {
				const server = yield* McpServer.McpServer;
				return {
					wake: (payload) =>
						server.notifications[CHANNEL_NOTIFICATION_METHOD](payload).pipe(Effect.asVoid),
				};
			}),
		);
}
