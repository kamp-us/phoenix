/**
 * The patched MCP edge contract: the `claude/channel` experimental capability and
 * the `notifications/claude/channel` custom server->client notification.
 *
 * effect's `effect/unstable/ai` `McpServer`/`McpSchema` fix the capability set and
 * the `ServerNotificationRpcs` union, with no public way to advertise `claude/channel`
 * or emit a custom notification. `patches/effect@4.0.0-beta.92.patch` (ADR 0038) adds
 * both; this module names the wire contract so consumers reference these constants
 * instead of magic strings, and the drift-guard test alongside pins the patch behavior.
 *
 * Generic (crew-agnostic): the wire contract only — no `crew/` coupling.
 */

export const CHANNEL_CAPABILITY = "claude/channel" as const;
export const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel" as const;

/**
 * The `experimental` capability object a channel-serving `McpServer` advertises —
 * pass as `McpServer.layer*({ ..., experimental: channelExperimentalCapability })`.
 */
export const channelExperimentalCapability: Record<string, Record<string, never>> = {
	[CHANNEL_CAPABILITY]: {},
};

/**
 * Shape of a `notifications/claude/channel` payload — the exact params the 2.1.214 Claude
 * Code channel handler validates: `content` (required string) is the channel body, `meta`
 * (optional `record<string,string>`) carries the originating peer in `meta.from`. The wake
 * is DROPPED at the recipient if `content` is absent, so this contract is load-bearing, not
 * cosmetic (#3479 — the crew emitted `{message, _meta}` and every inbound wake failed the
 * client's param validation).
 */
export interface ChannelNotificationPayload {
	readonly content: string;
	readonly meta?: Record<string, string>;
}
