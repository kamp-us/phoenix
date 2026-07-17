/**
 * standup/bind — the per-session bind constructor: the launch-time, launcher-owned binding each
 * crew session (epic #3237) comes up with. For a role + project root it derives the launch argv
 * fragment for ONE session — no process spawn here (the orchestration child #3299 spawns), pure
 * argv/JSON derivation over the already-resolved `LaunchConfig` channels dimension (#3293).
 *
 * It produces two coupled outputs the launcher inlines per invocation:
 *   1. `--mcp-config <json>` — the session's own channel MCP server as INLINE JSON baking
 *      `pipeline-crew-mcp session --role <role> --project-root <root>`. It must be per-invocation
 *      inline (not a static shared `.mcp.json`) because `--role`/`--project-root` vary across the
 *      concurrent sessions a stand-up launches at once.
 *   2. the channel-registration flag NAMING that same server — `--channels <refs>` for the
 *      allowlist mode, `--dangerously-load-development-channels <refs>` for dev. A server present
 *      in `.mcp.json`/`--mcp-config` alone is INERT: the Claude Code CLI only activates a channel
 *      once its server is also named in this flag (verified against the 2.1.212 bundle:
 *      `--channels <servers...>`, `--dangerously-load-development-channels <servers...>`,
 *      `--mcp-config <configs...>` load-from-JSON-string, and the `allowedChannelPlugins` gate).
 *
 * The one non-obvious thing: this FAILS CLOSED, like the config reader it consumes. A crew server
 * defined in `--mcp-config` but absent from the channel flag would come up inert (a silent
 * half-launch), and an allowlist-mode `plugin:` channel whose plugin the operator never allowlisted
 * is exactly what the CLI rejects — both are a launch to refuse with a named error, never paper over.
 */
import {Effect, Schema} from "effect";
import type {ChannelConfig} from "./config.ts";

/** The bin the session's channel MCP server runs (the package `bin`; AC1 bakes this verbatim). */
export const PIPELINE_CREW_MCP_BIN = "pipeline-crew-mcp";
/** The subcommand that runs one live crew session (`bin.ts`). */
export const CREW_SESSION_COMMAND = "session";
export const MCP_CONFIG_FLAG = "--mcp-config";
/** Allowlist mode: only servers named here load, gated by `allowedChannelPlugins` for plugin refs. */
export const ALLOWLIST_CHANNEL_FLAG = "--channels";
/** Dev mode: load channel servers not on the approved allowlist — local development only. */
export const DEV_CHANNEL_FLAG = "--dangerously-load-development-channels";

/** The `server:<name>` channel ref that names the crew session server registered under `serverName`. */
const crewServerRef = (serverName: string): string => `server:${serverName}`;

/** The inline `--mcp-config` JSON: one server keyed by `serverName`, baking the per-invocation session command. */
const sessionMcpConfigJson = (role: string, projectRoot: string, serverName: string): string =>
	JSON.stringify({
		mcpServers: {
			[serverName]: {
				command: PIPELINE_CREW_MCP_BIN,
				args: [CREW_SESSION_COMMAND, "--role", role, "--project-root", projectRoot],
			},
		},
	});

/** What one crew session binds at launch: the role, its root, and the derived launch argv fragment. */
export interface SessionBind {
	readonly role: string;
	readonly projectRoot: string;
	/** `["--mcp-config", "<inline JSON>"]`. */
	readonly mcpConfigArg: readonly [flag: string, json: string];
	/** The channel-registration flag + its server refs, e.g. `["--channels", "server:pipeline-crew", …]`. */
	readonly channelArg: readonly string[];
	/** The complete fragment `[...mcpConfigArg, ...channelArg]` the launcher inlines for this session. */
	readonly argv: readonly string[];
}

export interface SessionBindInput {
	readonly role: string;
	readonly projectRoot: string;
	/**
	 * The channel-ref name this session's own crew MCP server registers under (the `--mcp-config`
	 * map key). It MUST appear as `server:<serverName>` in `channels.servers`, else the server is
	 * defined-but-inert — the fail-closed `CrewServerNotRegisteredError` below.
	 */
	readonly serverName: string;
	/** The resolved channels dimension of the crew `LaunchConfig` (#3293), consumed read-only. */
	readonly channels: ChannelConfig;
}

/**
 * The crew session's own server is defined in `--mcp-config` but not named in the channel flag, so
 * it would come up INERT (`.mcp.json` alone is insufficient). Refuse the launch (AC2).
 */
export class CrewServerNotRegisteredError extends Schema.TaggedErrorClass<CrewServerNotRegisteredError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewServerNotRegisteredError",
	{
		serverName: Schema.String,
		servers: Schema.Array(Schema.String),
	},
) {}

/**
 * An allowlist-mode `plugin:<plugin>:<server>` channel names a plugin the config's
 * `allowedChannelPlugins` doesn't list — the exact rejection the CLI raises ("not on the approved
 * channels allowlist"). Dev mode is the sanctioned escape hatch, so this fires only under `--channels`.
 */
export class ChannelPluginNotAllowedError extends Schema.TaggedErrorClass<ChannelPluginNotAllowedError>()(
	"@kampus/pipeline-crew-mcp/standup/ChannelPluginNotAllowedError",
	{
		plugin: Schema.String,
		ref: Schema.String,
		allowedChannelPlugins: Schema.Array(Schema.String),
	},
) {}

/** The plugin segment of a `plugin:<plugin>:<server>` ref (grammar-guaranteed present by `ChannelServerRef`). */
const pluginOf = (ref: string): string | undefined =>
	ref.startsWith("plugin:") ? ref.split(":")[1] : undefined;

/**
 * Build one crew session's launch bind: the inline `--mcp-config` server + the channel-registration
 * flag naming that same server. Fails closed if the crew server would be inert (unnamed in the flag),
 * or — under `--channels` only — if a plugin channel names a plugin outside `allowedChannelPlugins`.
 */
export const buildSessionBind = (
	input: SessionBindInput,
): Effect.Effect<SessionBind, CrewServerNotRegisteredError | ChannelPluginNotAllowedError> =>
	Effect.gen(function* () {
		const {role, projectRoot, serverName, channels} = input;
		const servers = channels.servers;

		if (!servers.includes(crewServerRef(serverName))) {
			return yield* Effect.fail(new CrewServerNotRegisteredError({serverName, servers}));
		}

		// The allowlist gate applies to `--channels` only: dev mode's whole purpose is loading
		// channels NOT on the approved allowlist, so it deliberately skips the plugin check.
		if (channels.mode === "allowlist") {
			for (const ref of servers) {
				const plugin = pluginOf(ref);
				if (plugin !== undefined && !channels.allowedChannelPlugins.includes(plugin)) {
					return yield* Effect.fail(
						new ChannelPluginNotAllowedError({
							plugin,
							ref,
							allowedChannelPlugins: channels.allowedChannelPlugins,
						}),
					);
				}
			}
		}

		const channelFlag = channels.mode === "development" ? DEV_CHANNEL_FLAG : ALLOWLIST_CHANNEL_FLAG;
		const mcpConfigArg: readonly [string, string] = [
			MCP_CONFIG_FLAG,
			sessionMcpConfigJson(role, projectRoot, serverName),
		];
		const channelArg: readonly string[] = [channelFlag, ...servers];

		return {
			role,
			projectRoot,
			mcpConfigArg,
			channelArg,
			argv: [...mcpConfigArg, ...channelArg],
		};
	});
