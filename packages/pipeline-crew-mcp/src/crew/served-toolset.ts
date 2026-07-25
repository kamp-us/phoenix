/**
 * crew/served-toolset — the ONE declaration of what a live crew session's MCP server serves, and of
 * how a seat's `tools:` allowlist names those tools. `assembleCrewSession` schema-fences and registers
 * exactly `CREW_SESSION_TOOLKITS`; the launcher's seat assert (`standup/toolset-assert.ts`) reconciles
 * every seat's declared `mcp__*` token against the same array. One source, so "declared" and "served"
 * cannot drift through a hand-maintained second list.
 *
 * The one non-obvious thing: a seat's allowlist token is the CLI's callable name for a served tool —
 * `mcp__` + the server name sanitized by `replace(/[^a-zA-Z0-9_-]/g, "_")` + `__` + the tool name
 * (the derivation is single-sourced in `claude-plugins/pipeline-crew/CHANNEL-TOOL.md`). Deriving the
 * token here instead of hand-writing the string is what makes "can this declared token EVER resolve?"
 * a decidable, static question rather than something only a live boot can answer.
 */
import type {Tool, Toolkit} from "effect/unstable/ai";
import {ClaimToolkit} from "../edge/claim-tool.ts";
import {KindsToolkit} from "../edge/kinds-tool.ts";
import {ReleaseToolkit} from "../edge/release-tool.ts";
import {ChannelToolkit} from "../edge/send-tool.ts";

/** The MCP server identity a crew session advertises over stdio when none is configured. */
export const SESSION_SERVER_NAME = "@kampus/pipeline-crew-mcp" as const;

/** Every toolkit a live crew session registers on its one served `McpServer` (`assembleCrewSession`). */
export const CREW_SESSION_TOOLKITS: ReadonlyArray<Toolkit.Any> = [
	ChannelToolkit,
	ClaimToolkit,
	ReleaseToolkit,
	KindsToolkit,
];

/** The tool names a connected crew session server actually serves, read off the toolkits it registers. */
export const CREW_SERVED_TOOL_NAMES: ReadonlySet<string> = new Set(
	CREW_SESSION_TOOLKITS.flatMap((toolkit) =>
		Object.values(toolkit.tools).map((tool: Tool.Any) => tool.name),
	),
);

/** Sanitize an MCP server name into the segment claude-code builds a tool token from. */
export const sanitizeMcpServerName = (server: string): string =>
	server.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The `mcp__<sanitized server>__` prefix every crew channel tool's allowlist token carries. */
export const CREW_MCP_TOOL_PREFIX = `mcp__${sanitizeMcpServerName(SESSION_SERVER_NAME)}__`;

/** The `tools:` allowlist token a seat must declare to call one crew channel tool. */
export const crewMcpToolToken = (tool: string): string => `${CREW_MCP_TOOL_PREFIX}${tool}`;

/** The crew tool an allowlist entry names, or null when the entry is not a crew-server MCP token. */
export const crewMcpToolName = (entry: string): string | null =>
	entry.startsWith(CREW_MCP_TOOL_PREFIX) ? entry.slice(CREW_MCP_TOOL_PREFIX.length) : null;

/**
 * The channel tools EVERY launched crew seat must declare. A seat that can send but cannot resolve a
 * kind's shape discovers every payload by rejected send (CHANNEL-TOOL.md, #3761/#3622) — so the pair is
 * a contract, not a per-role choice. `channel_claim`/`channel_release` stay role-scoped by design: only
 * the engine deconflicts resources, so they are deliberately absent from the bridges' declarations.
 */
export const REQUIRED_SEAT_CHANNEL_TOOLS: readonly string[] = ["channel_send", "channel_kinds"];
