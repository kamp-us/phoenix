/**
 * standup/bind — the per-session bind constructor: the launch-time, launcher-owned binding each
 * crew session (epic #3237) comes up with. For a role + project root it derives the launch inputs
 * for ONE session — no process spawn here (the orchestration child #3299 spawns), pure derivation
 * over the already-resolved `LaunchConfig` channels dimension (#3293).
 *
 * It produces two coupled outputs the launcher wires per invocation:
 *   1. `serverConfig` — the crew channel MCP server's config value (`<node> <abs bin.ts> session
 *      --role <role> --project-root <root>`), which the launcher writes into a PERSISTED config scope:
 *      a per-pane project-scope leaf `.mcp.json` (`<pane cwd>/.mcp.json`, register-project-scope.ts).
 *      The old inline `--mcp-config` path is GONE: claude 2.1.212's channel-ref resolver validates a
 *      `server:<name>` ref against the four persisted scopes only (enterprise/user/project/local) and
 *      NEVER consults an inline `--mcp-config` server, so a server handed only inline is structurally
 *      invisible to the resolver and the channel comes up inert crew-wide (issue #3444). The command
 *      is the launcher's own node (`process.execPath`) + the ABSOLUTE `bin.ts` path — a bare unlinked
 *      package bin name never resolves on the launched session's PATH (#3425); this mirrors
 *      ensure-tracker.ts's detached-child spawn, the package's canonical bin.ts runner.
 *   2. the channel-registration flag NAMING that same server — `--channels <refs>` for the
 *      allowlist mode, `--dangerously-load-development-channels <refs>` for dev. A server present in a
 *      persisted scope alone is INERT: the CLI only activates a channel once its server is also named
 *      in this flag (verified against the 2.1.212 bundle: `--channels <servers...>`,
 *      `--dangerously-load-development-channels <servers...>`, and the `allowedChannelPlugins` gate).
 *
 * The one non-obvious thing: this FAILS CLOSED, like the config reader it consumes. Three ways a
 * bind would come up inert are each a launch to refuse with a named error, never paper over: the
 * crew server's `bin.ts` not resolving on disk (`CrewSessionBinUnresolvableError`, #3425), the crew
 * server not named in the channel flag (`CrewServerNotRegisteredError`), and an allowlist-mode
 * `plugin:` channel whose plugin the operator never allowlisted (`ChannelPluginNotAllowedError`, the
 * exact rejection the CLI raises). The project-scope WRITE is a launcher side effect, so its own
 * fail-closed guard lives at that write (register-project-scope.ts / orchestrate.ts), not here.
 */
import {existsSync} from "node:fs";
import {join} from "node:path";
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
/** Sets the launched session's model to the role's configured tier (#3423); omitted when no tier. */
export const MODEL_FLAG = "--model";
/**
 * Sets a visible per-session display name — shown in the prompt box, `/resume` picker, and terminal
 * title (grounded against the installed CLI 2.1.214: `-n, --name <name>`). This is the on-screen
 * role identity; `--agent` swaps the system prompt but is NOT visible, so it's the wrong flag for
 * the operator-legibility symptom (#3443).
 */
export const NAME_FLAG = "--name";
/**
 * Boots the crew session's plugin substrate so `--agent <role>` can resolve the role's agent-def as
 * the session persona. `--agent` binds only an agent-def already in the launched session's resolver,
 * and a pipeline-crew agent-def enters that resolver as a source:"plugin" def ONLY once the plugin is
 * loaded — so without `--plugin-dir <…/claude-plugins/pipeline-crew>` the `--agent <role>` below falls
 * through to the generic general-purpose default (the observed generic boot, #3447). The pipeline-crew
 * plugin declares no MCP server (the crew channel MCP is wired separately via the channel flag), so a
 * plain `--plugin-dir` adds only the agent-defs. The plugin agent-defs are named `crew-<role>`, not
 * the bare role: a bare `name:` frontmatter becomes the def's `agentType` verbatim with no plugin
 * namespacing, and the agent pool is last-write-wins with personal `~/.claude/agents/` iterated after
 * plugins — so a same-named personal def would SHADOW the plugin def and `--agent <role>` would boot
 * the personal persona instead (the #3447 collision). The `crew-<role>` names are collision-free, so
 * `--agent` passes `crew-<role>` (the bare role mapped at the argv site below); the bare role stays the
 * key everywhere else — `CREW_ROLES`, the channel role map, model tiering, `--name` (ADR 0189, #3447).
 */
export const PLUGIN_DIR_FLAG = "--plugin-dir";
/** Boots the session AS its role persona by resolving the plugin agent-def named `crew-<role>` (see PLUGIN_DIR_FLAG, #3447). */
export const AGENT_FLAG = "--agent";
/**
 * The launcher's initial boot turn: a positional prompt handed to `claude` at launch so the freshly
 * spawned session TAKES a first turn instead of loading its persona and sitting idle. This is the only
 * missing piece for the crew engine's cold-start self-drain (#3516): the role def (#3512) already
 * carries the "on boot, sweep the board and start the self-drain loop" behavior, but a persona-loaded
 * session only reads that def — it never fires until it is given a turn, and a launcher that passes no
 * initial prompt never gives it one. It is a bare positional (no flag) so it maps to the CLI's
 * `[prompt]` argument and — with NO `-p`/`--print` — keeps the session INTERACTIVE, i.e. it runs this
 * turn and stays alive to self-drain (grounded on the installed CLI 2.1.214:
 * `Usage: claude [options] [command] [prompt]` — "starts an interactive session by default, use
 * -p/--print for non-interactive output"). Role-agnostic on purpose: it nudges the session to run
 * whatever cold-start its own def defines, so it fits every crew role (bridge + engine) without the
 * launcher re-encoding each persona's boot behavior.
 */
export const BOOT_PROMPT =
	"Begin now. Run your role's on-boot cold-start behavior as defined by your agent instructions: announce your presence on the channel, then start your standing work loop under your own power. Do not wait to be pinged, relayed to, or told to start.";
/** The pipeline-crew plugin root under a given project root — the dir `--plugin-dir` loads agent-defs from. */
const crewPluginDir = (projectRoot: string): string =>
	join(projectRoot, "claude-plugins/pipeline-crew");
/** Allowlist mode: only servers named here load, gated by `allowedChannelPlugins` for plugin refs. */
export const ALLOWLIST_CHANNEL_FLAG = "--channels";
/** Dev mode: load channel servers not on the approved allowlist — local development only. */
export const DEV_CHANNEL_FLAG = "--dangerously-load-development-channels";

/** The `server:<name>` channel ref that names the crew session server registered under `serverName`. */
const crewServerRef = (serverName: string): string => `server:${serverName}`;

/**
 * A crew channel MCP server's persisted-scope config value: the `command` + `args` the CLI spawns as
 * the stdio server. This is the value the launcher writes to the pane's project-scope `.mcp.json` under
 * `serverName` (register-project-scope.ts) — the exact shape a persisted-scope `mcpServers[name]` entry
 * carries, so the channel resolver (which reads persisted scopes, #3444) sees the server.
 */
export interface CrewServerConfig {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * The crew session's own server config: the launcher's node running the per-invocation session
 * command. When an engine's launcher-assigned `instance` (#3297) is present it is baked as
 * `--instance <id>` so the launched session binds THAT identity; a bridge (singleton, no instance)
 * omits the flag.
 */
const sessionServerConfig = (
	role: string,
	projectRoot: string,
	instance: string | undefined,
): CrewServerConfig => ({
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
});

/** What one crew session binds at launch: the role, its root, the persisted-scope server, and the launch argv. */
export interface SessionBind {
	readonly role: string;
	readonly projectRoot: string;
	/** The channel-server name this session registers under — the `mcpServers[…]` key its persisted-scope entry uses. */
	readonly serverName: string;
	/** The crew server's persisted-scope config value the launcher writes to the pane's project-scope `.mcp.json` (#3444). */
	readonly serverConfig: CrewServerConfig;
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
	/**
	 * `["--plugin-dir", "<projectRoot>/claude-plugins/pipeline-crew"]` — loads the pipeline-crew plugin
	 * so its agent-defs enter the launched session's resolver, the precondition `--agent` needs (see
	 * PLUGIN_DIR_FLAG, #3447).
	 */
	readonly pluginDirArg: readonly [flag: string, dir: string];
	/** `["--agent", "crew-<role>"]` — boots the session AS its role persona (collision-free name, see AGENT_FLAG). */
	readonly agentArg: readonly [flag: string, agentName: string];
	/**
	 * `[BOOT_PROMPT]` — the single positional initial prompt that hands the spawned session its first
	 * turn so its def's on-boot cold-start fires from launch, not on a hand-kick (#3516; see BOOT_PROMPT).
	 * It rides the argv TAIL, after the non-variadic `--name <name>`, so it lands as the CLI's `[prompt]`
	 * positional rather than being swallowed by the variadic `--channels`/dev-channel option ahead of it.
	 */
	readonly bootPromptArg: readonly [prompt: string];
	/**
	 * The complete argv
	 * `[...modelArg, ...pluginDirArg, ...agentArg, ...channelArg, ...nameArg, ...bootPromptArg]` the
	 * launcher passes to `claude`. It boots the role persona (`--plugin-dir` + `--agent`, #3447), then
	 * gives the session its boot turn via the tail positional prompt (#3516), and no longer carries
	 * `--mcp-config`: the crew server now registers via the pane's project-scope `.mcp.json`
	 * (`serverConfig`), which is what the channel resolver actually reads (#3444).
	 */
	readonly argv: readonly string[];
}

export interface SessionBindInput {
	readonly role: string;
	readonly projectRoot: string;
	/**
	 * The channel-ref name this session's own crew MCP server registers under (the persisted-scope
	 * `mcpServers` map key). It MUST appear as `server:<serverName>` in `channels.servers`, else the
	 * server is defined-but-inert — the fail-closed `CrewServerNotRegisteredError` below.
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
 * The crew session's own server is not named in the channel flag, so it would come up INERT (a
 * persisted-scope entry alone is insufficient — the flag is what activates the channel). Refuse the
 * launch (AC2).
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
 * Build one crew session's launch bind: the crew server's persisted-scope config value + the
 * channel-registration flag naming that same server. Fails closed if the crew server would be inert
 * (unnamed in the flag), or — under `--channels` only — if a plugin channel names a plugin outside
 * `allowedChannelPlugins`.
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

		// Resolvability before anything else: the bin the server command runs must exist on disk, else
		// the launched `<node> <bin.ts>` fails to spawn and the channel is inert (#3425).
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
		const serverConfig = sessionServerConfig(role, projectRoot, instance);
		const channelArg: readonly string[] = [channelFlag, ...servers];
		// The role's tier boots the session on its `--model` (#3423); a role with no tier emits none,
		// keeping the CLI-default boot rather than guessing. `tierModel` is total over the `Tier` enum.
		const modelArg: readonly string[] = tier !== undefined ? [MODEL_FLAG, tierModel(tier)] : [];
		// An engine appends its per-instance discriminator so the N engine panes are distinctly named
		// (AC2); a bridge is the bare singleton role. Same instance that keeps engine inboxes distinct.
		const displayName = instance !== undefined ? `${role}-${instance}` : role;
		const nameArg: readonly [string, string] = [NAME_FLAG, displayName];
		// The persona boot (#3447): --plugin-dir loads the pipeline-crew plugin so --agent resolves the
		// role's agent-def instead of falling through to general-purpose. The agent-def name is the
		// collision-free `crew-<role>`, so map the bare role at this argv site (see AGENT_FLAG for why).
		const pluginDirArg: readonly [string, string] = [PLUGIN_DIR_FLAG, crewPluginDir(projectRoot)];
		const agentArg: readonly [string, string] = [AGENT_FLAG, `crew-${role}`];
		// The launcher's boot turn (#3516): a tail positional prompt so the spawned session fires its
		// def's cold-start instead of idling. Tail placement (after the non-variadic --name) keeps it out
		// of the variadic channel option's reach; no -p/--print keeps the session interactive to self-drain.
		const bootPromptArg: readonly [string] = [BOOT_PROMPT];

		return {
			role,
			projectRoot,
			serverName,
			serverConfig,
			channelArg,
			modelArg,
			nameArg,
			pluginDirArg,
			agentArg,
			bootPromptArg,
			argv: [
				...modelArg,
				...pluginDirArg,
				...agentArg,
				...channelArg,
				...nameArg,
				...bootPromptArg,
			],
		};
	});
