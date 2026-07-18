/**
 * standup/bind — the per-session bind constructor: the launch-time, launcher-owned binding each
 * crew session (epic #3237) comes up with. For a role + project root it derives the launch argv
 * fragment for ONE session — no process spawn here (the orchestration child #3299 spawns), pure
 * argv/JSON derivation over the already-resolved `LaunchConfig` channels dimension (#3293).
 *
 * It produces two coupled outputs the launcher inlines per invocation:
 *   1. `--mcp-config <json>` — the session's own channel MCP server as INLINE JSON baking
 *      `<node> <abs bin.ts> session --role <role> --project-root <root>`. It must be per-invocation
 *      inline (not a static shared `.mcp.json`) because `--role`/`--project-root` vary across the
 *      concurrent sessions a stand-up launches at once. The command is the launcher's own node
 *      (`process.execPath`) + the ABSOLUTE `bin.ts` path — a bare, unlinked package bin name never
 *      resolves on the launched session's PATH, so it would come up silently inert (#3425); this
 *      mirrors ensure-tracker.ts's detached-child spawn (`process.execPath` + a `fileURLToPath`
 *      module path), the package's canonical bin.ts runner.
 *   2. the channel-registration flag NAMING that same server — `--channels <refs>` for the
 *      allowlist mode, `--dangerously-load-development-channels <refs>` for dev. A server present
 *      in `.mcp.json`/`--mcp-config` alone is INERT: the Claude Code CLI only activates a channel
 *      once its server is also named in this flag (verified against the 2.1.212 bundle:
 *      `--channels <servers...>`, `--dangerously-load-development-channels <servers...>`,
 *      `--mcp-config <configs...>` load-from-JSON-string, and the `allowedChannelPlugins` gate).
 *
 * The one non-obvious thing: this FAILS CLOSED, like the config reader it consumes. Three ways a
 * bind would come up inert are each a launch to refuse with a named error, never paper over: the
 * crew server's `bin.ts` not resolving on disk (`CrewSessionBinUnresolvableError`, #3425), the crew
 * server defined in `--mcp-config` but absent from the channel flag (`CrewServerNotRegisteredError`),
 * and an allowlist-mode `plugin:` channel whose plugin the operator never allowlisted
 * (`ChannelPluginNotAllowedError`, the exact rejection the CLI raises).
 */
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Effect, Schema} from "effect";
import {type ChannelConfig, type Tier, tierModel} from "./config.ts";

/**
 * The absolute path to this package's `bin.ts` entry, resolved from THIS module's own location so it
 * is correct wherever the package is installed (a distributable plugin), never a machine-hardcoded
 * path. The launched crew MCP server runs `<node> <this> session …`; a bare unlinked bin name would
 * not resolve on the launched session's PATH (#3425). Same idiom as ensure-tracker.ts's `SELF_PATH`.
 */
export const CREW_SESSION_BIN_PATH = fileURLToPath(new URL("../bin.ts", import.meta.url));
/** The subcommand that runs one live crew session (`bin.ts`). */
export const CREW_SESSION_COMMAND = "session";
/**
 * Binds the launcher-assigned per-instance identity (#3297) into the session command, so the
 * launched engine comes up on THAT address instead of `crew/session.ts` re-minting its own runtime
 * instance — the C5 handoff #3297 left for bind to turn into argv (#3354, seam 3).
 */
export const CREW_SESSION_INSTANCE_FLAG = "--instance";
export const MCP_CONFIG_FLAG = "--mcp-config";
/** Sets the launched session's model to the role's configured tier (#3423); omitted when no tier. */
export const MODEL_FLAG = "--model";
/**
 * Sets a visible per-session display name — shown in the prompt box, `/resume` picker, and terminal
 * title (grounded against the installed CLI 2.1.214: `-n, --name <name>`). This is the on-screen
 * role identity; `--agent` swaps the system prompt but is NOT visible, so it's the wrong flag for
 * the operator-legibility symptom (#3443).
 */
export const NAME_FLAG = "--name";
/** Allowlist mode: only servers named here load, gated by `allowedChannelPlugins` for plugin refs. */
export const ALLOWLIST_CHANNEL_FLAG = "--channels";
/** Dev mode: load channel servers not on the approved allowlist — local development only. */
export const DEV_CHANNEL_FLAG = "--dangerously-load-development-channels";

/** The `server:<name>` channel ref that names the crew session server registered under `serverName`. */
const crewServerRef = (serverName: string): string => `server:${serverName}`;

/**
 * The inline `--mcp-config` JSON: one server keyed by `serverName`, baking the per-invocation session
 * command. When an engine's launcher-assigned `instance` (#3297) is present it is baked as
 * `--instance <id>` so the launched session binds THAT identity; a bridge (singleton, no instance)
 * omits the flag.
 */
const sessionMcpConfigJson = (
	role: string,
	projectRoot: string,
	serverName: string,
	instance: string | undefined,
): string =>
	JSON.stringify({
		mcpServers: {
			[serverName]: {
				command: process.execPath,
				args: [
					CREW_SESSION_BIN_PATH,
					CREW_SESSION_COMMAND,
					"--role",
					role,
					"--project-root",
					projectRoot,
					...(instance !== undefined ? [CREW_SESSION_INSTANCE_FLAG, instance] : []),
				],
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
	/** `["--model", "<alias>"]` when the role has a configured tier (#3423), else `[]` (CLI default). */
	readonly modelArg: readonly string[];
	/**
	 * `["--name", "<display name>"]` — the visible per-session identity (#3443). A bridge is the
	 * singleton `role`; an engine is `role-<instance>` so the N engine panes come up distinctly named
	 * (AC2) rather than N identical `engineering-manager`s — the per-instance discriminator is the
	 * same one that already keeps engine inboxes collision-free (session-set.ts).
	 */
	readonly nameArg: readonly [flag: string, name: string];
	/** The complete fragment `[...modelArg, ...mcpConfigArg, ...channelArg, ...nameArg]` the launcher inlines for this session. */
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
	/**
	 * The launcher-assigned per-instance identity (#3297) an engine session binds — baked into the
	 * session argv as `--instance <id>` so the launched engine comes up on that address rather than
	 * re-minting its own runtime instance (#3354, seam 3). A bridge is a singleton and omits it.
	 */
	readonly instance?: string | undefined;
	/**
	 * The role's configured model tier (#3423) — emitted as `--model <alias>` so the launched session
	 * boots on that tier's model, not the CLI default. Omitted (undefined) ⇒ no `--model`: a role that
	 * set no tier keeps today's default-model boot rather than being forced onto a guessed one.
	 */
	readonly tier?: Tier | undefined;
	/** The resolved channels dimension of the crew `LaunchConfig` (#3293), consumed read-only. */
	readonly channels: ChannelConfig;
	/**
	 * Whether the crew server's `bin.ts` resolves on disk — injected so the fail-closed
	 * resolvability guard is unit-testable without moving the real file. Default: the real
	 * `existsSync`, checked against `CREW_SESSION_BIN_PATH` (#3425).
	 */
	readonly binExists?: (binPath: string) => boolean;
}

/**
 * The crew session's own MCP server names a `bin.ts` that does not resolve on disk, so `<node>
 * <bin.ts>` would fail to spawn and the channel would come up silently inert — the missing sibling
 * to `CrewServerNotRegisteredError` that let #3425 be SILENT (registration was guarded, resolvability
 * was not). Refuse the launch: a bound bind now implies the bin actually resolves.
 */
export class CrewSessionBinUnresolvableError extends Schema.TaggedErrorClass<CrewSessionBinUnresolvableError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewSessionBinUnresolvableError",
	{
		binPath: Schema.String,
	},
) {}

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
): Effect.Effect<
	SessionBind,
	CrewSessionBinUnresolvableError | CrewServerNotRegisteredError | ChannelPluginNotAllowedError
> =>
	Effect.gen(function* () {
		const {role, projectRoot, serverName, instance, tier, channels} = input;
		const binExists = input.binExists ?? existsSync;
		const servers = channels.servers;

		// Resolvability before anything else: the bin the `--mcp-config` command runs must exist on
		// disk, else the launched `<node> <bin.ts>` fails to spawn and the channel is inert (#3425).
		if (!binExists(CREW_SESSION_BIN_PATH)) {
			return yield* Effect.fail(
				new CrewSessionBinUnresolvableError({binPath: CREW_SESSION_BIN_PATH}),
			);
		}

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
			sessionMcpConfigJson(role, projectRoot, serverName, instance),
		];
		const channelArg: readonly string[] = [channelFlag, ...servers];
		// The role's tier boots the session on its `--model` (#3423); a role with no tier emits none,
		// keeping the CLI-default boot rather than guessing. `tierModel` is total over the `Tier` enum.
		const modelArg: readonly string[] = tier !== undefined ? [MODEL_FLAG, tierModel(tier)] : [];
		// An engine appends its per-instance discriminator so the N engine panes are distinctly named
		// (AC2); a bridge is the bare singleton role. Same instance that keeps engine inboxes distinct.
		const displayName = instance !== undefined ? `${role}-${instance}` : role;
		const nameArg: readonly [string, string] = [NAME_FLAG, displayName];

		return {
			role,
			projectRoot,
			mcpConfigArg,
			channelArg,
			modelArg,
			nameArg,
			argv: [...modelArg, ...mcpConfigArg, ...channelArg, ...nameArg],
		};
	});
