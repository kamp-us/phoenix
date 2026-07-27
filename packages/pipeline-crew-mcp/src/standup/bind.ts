/**
 * standup/bind — the per-session bind constructor: the launch-time, launcher-owned binding each
 * crew session (epic #3237) comes up with. For a role + project root it derives the launch inputs
 * for ONE session — no process spawn here (the orchestration child #3299 spawns), pure derivation
 * over the already-resolved `LaunchConfig` channels dimension (#3293).
 *
 * It produces two coupled outputs the launcher wires per invocation: the channel-registration flag
 * (`--channels <refs>` for allowlist, `--dangerously-load-development-channels <refs>` for dev — a
 * channel is INERT until its server is named there) and the `channelBinding` that says HOW the named
 * server reaches the CLI's channel-ref resolver. Those two shapes are the two supported launch paths,
 * and `ChannelBinding` makes the wrong pairing unrepresentable rather than a runtime branch:
 *
 *   - **allowlist / production ⇒ `plugin-channel`** (#3920). The crew server is declared ONCE, statically,
 *     by the marketplace plugin `claude-plugins/pipeline-crew-mcp` (#3366 / ADR 0201), and the session
 *     binds it by the `plugin:<name>@<marketplace>` ref the CLI's `--channels` grammar accepts. Nothing
 *     is written to a persisted scope — the plugin IS the persisted declaration. Because that one static
 *     declaration serves every role, the per-pane role/root/instance travel as pane ENV instead of argv
 *     (`env` below), which `crew/session-inputs.ts` resolves flag-or-env.
 *   - **development ⇒ `project-scope`** (#3444, unchanged). Dev mode's inline `server:<name>` ref resolves
 *     only against the four PERSISTED config scopes (enterprise/user/project/local) — never an inline
 *     `--mcp-config` — so the launcher writes the server's config value into a per-pane leaf `.mcp.json`
 *     (register-project-scope.ts). The command is the launcher's own node (`process.execPath`) + the
 *     ABSOLUTE `bin.ts` path, since a bare unlinked package bin name never resolves on the launched
 *     session's PATH (#3425); role/root/instance are baked into that argv, so dev needs no pane env.
 *
 * The one non-obvious thing: this FAILS CLOSED, like the config reader it consumes. Three ways a
 * bind would come up inert are each a launch to refuse with a named error, never paper over: the
 * crew server's `bin.ts` not resolving on disk (`CrewSessionBinUnresolvableError`, #3425), the crew
 * channel not named in the channel flag at all (`CrewServerNotRegisteredError` — the required ref
 * differs per mode), and an allowlist-mode `plugin:` channel whose plugin the operator never
 * allowlisted (`ChannelPluginNotAllowedError`, the exact rejection the CLI raises). The project-scope
 * WRITE is a launcher side effect, so its own fail-closed guard lives at that write
 * (register-project-scope.ts / orchestrate.ts), not here.
 */
import {fileURLToPath} from "node:url";
import {Effect, FileSystem, Path, Schema} from "effect";
import {
	CREW_INSTANCE_ENV,
	CREW_PROJECT_ROOT_ENV,
	CREW_ROLE_ENV,
	driveOf,
	isCrewRole,
} from "../crew/index.ts";
import {type ChannelConfig, type Tier, tierModel, type WipCap} from "./config.ts";

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
 * -p/--print for non-interactive output"). Role-agnostic on purpose within its scope: it nudges the
 * session to run whatever cold-start its own def defines, so it fits every SELF-DRIVING role (the
 * bridges + engines that run a standing loop) without the launcher re-encoding each persona's boot
 * behavior. It is NOT handed to a human-in-the-loop role (the cartographer): a HITL role has no
 * standing loop, so "start your loop under your own power" would make it confabulate work — it boots
 * idle with no prompt instead (the drive branch in `buildSessionBind`, #3524).
 */
export const BOOT_PROMPT =
	"Begin now. Run your role's on-boot cold-start behavior as defined by your agent instructions: announce your presence on the channel, then start your standing work loop under your own power. Do not wait to be pinged, relayed to, or told to start.";
/**
 * The engine's configured WIP cap, rendered as the sentence appended to its boot turn (#4330).
 *
 * The boot turn is the delivery vehicle because it is the one launch surface the SESSION itself
 * reads: the pane env and the server argv reach the crew MCP server process, not the model, and the
 * def deliberately carries no number ("your configured cap"). Without this the operator's value was
 * decoded and then reached nobody, so each engine improvised a cap — silently, with nothing holding
 * the number to compare against (#4330). Only the numbers ride here; the doctrine they are read
 * under (ceiling-not-target, borrow/rebalance, a lane frees on landing) lives in the def.
 */
export const wipCapClause = (cap: WipCap): string =>
	`Your WIP cap is the operator's configured value, delivered at launch: ${cap.productLanes} concurrent product ${cap.productLanes === 1 ? "lane" : "lanes"} + ${cap.platformLanes} concurrent platform/pipeline ${cap.platformLanes === 1 ? "lane" : "lanes"}, ${cap.productLanes + cap.platformLanes} in total. These are the numbers your definition's WIP-cap section defers to — apply them as written and never improvise a cap; state them verbatim whenever you report your occupancy.`;

/** The pipeline-crew plugin root segment `--plugin-dir` joins onto a project root to load agent-defs from. */
export const CREW_PLUGIN_SUBDIR = "claude-plugins/pipeline-crew";
/** Allowlist mode: only servers named here load, gated by `allowedChannelPlugins` for plugin refs. */
export const ALLOWLIST_CHANNEL_FLAG = "--channels";
/** Dev mode: load channel servers not on the approved allowlist — local development only. */
export const DEV_CHANNEL_FLAG = "--dangerously-load-development-channels";

/**
 * The crew channel's DISTRIBUTION identity — the marketplace plugin that declares the crew MCP server
 * (`claude-plugins/pipeline-crew-mcp/.claude-plugin/plugin.json`, registered in `.claude-plugin/marketplace.json`).
 * These are the product's own published names, single-sourced here so the launcher, its allowlist gate,
 * and the operator config template can never drift apart (#3366 / ADR 0201). They are NOT operator data:
 * nothing here varies per install, so nothing here belongs in the personalization seam.
 */
export const CREW_CHANNEL_PLUGIN = "pipeline-crew-mcp";
export const CREW_CHANNEL_MARKETPLACE = "kampus";
/** The `plugin:<name>@<marketplace>` ref allowlist mode binds the crew channel through (`--channels`, #3920). */
export const CREW_PLUGIN_CHANNEL_REF = `plugin:${CREW_CHANNEL_PLUGIN}@${CREW_CHANNEL_MARKETPLACE}`;

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

/**
 * How the named crew channel reaches the CLI's channel-ref resolver — the two launch paths, as a union
 * so "plugin channel AND a per-pane `.mcp.json` write" is unrepresentable rather than a runtime branch
 * the launcher could get wrong. See the module docblock for why each path is shaped the way it is.
 */
export type ChannelBinding =
	/** allowlist/production: the marketplace plugin's own static declaration; nothing for the launcher to write (#3920). */
	| {readonly kind: "plugin-channel"; readonly ref: string}
	/** development: the launcher writes this server config to the pane's project-scope leaf `.mcp.json` (#3444). */
	| {
			readonly kind: "project-scope";
			/** The `mcpServers[…]` key the pane's persisted-scope entry uses. */
			readonly serverName: string;
			readonly serverConfig: CrewServerConfig;
	  };

/** What one crew session binds at launch: the role, its root, how its channel binds, the pane env, and the launch argv. */
export interface SessionBind {
	readonly role: string;
	readonly projectRoot: string;
	/** How this session's crew channel binds — the plugin ref (allowlist) or the project-scope server (dev). */
	readonly channelBinding: ChannelBinding;
	/**
	 * The pane environment this session must be spawned with (`CREW_ROLE`/`CREW_PROJECT_ROOT`/`CREW_INSTANCE`,
	 * resolved by crew/session-inputs.ts). NON-EMPTY only on the `plugin-channel` path, where the plugin's one
	 * static `.mcp.json` cannot carry a per-pane `--role` — the env is what makes the shared declaration resolve
	 * per pane, and it is also what replaces #3444's per-pane filesystem isolation (see the module docblock).
	 * EMPTY under dev mode, whose server argv already carries the role — so dev's spawn is byte-identical to
	 * before this seam existed.
	 */
	readonly env: Readonly<Record<string, string>>;
	/** The channel-registration flag + its server refs, e.g. `["--channels", "plugin:…@…", …]`. */
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
	 * A self-driving role's boot turn: `[BOOT_PROMPT]`, plus the `wipCapClause` sentence when the role
	 * carries a configured lane cap (#4330) — the single positional initial prompt that hands
	 * the spawned session its first turn so its def's on-boot cold-start fires from launch, not on a
	 * hand-kick (#3516; see BOOT_PROMPT). It rides the argv TAIL, after the non-variadic `--name <name>`,
	 * so it lands as the CLI's `[prompt]` positional rather than being swallowed by the variadic
	 * `--channels`/dev-channel option ahead of it. A human-in-the-loop role emits `[]` (no boot turn) so
	 * it comes up idle waiting for the human rather than manufacturing work (the drive branch, #3524).
	 */
	readonly bootPromptArg: readonly [] | readonly [prompt: string];
	/**
	 * The complete argv
	 * `[...modelArg, ...pluginDirArg, ...agentArg, ...channelArg, ...nameArg, ...bootPromptArg]` the
	 * launcher passes to `claude`. It boots the role persona (`--plugin-dir` + `--agent`, #3447), then
	 * gives the session its boot turn via the tail positional prompt (#3516). It carries no
	 * `--mcp-config` and no role: the channel resolver reads `channelBinding` (a persisted scope in dev,
	 * the plugin's own declaration in allowlist mode), and on the plugin path the role arrives as `env`.
	 */
	readonly argv: readonly string[];
}

export interface SessionBindInput {
	readonly role: string;
	readonly projectRoot: string;
	/**
	 * The channel-ref name this session's own crew MCP server registers under (the persisted-scope
	 * `mcpServers` map key) on the DEV path, where it MUST appear as `server:<serverName>` in
	 * `channels.servers`, else the server is defined-but-inert — the fail-closed
	 * `CrewServerNotRegisteredError` below. Unused on the plugin-channel path, whose required ref is
	 * the fixed `CREW_PLUGIN_CHANNEL_REF`.
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
	/**
	 * The engine's configured concurrent-lane cap (#4330) — appended to the boot turn as
	 * `wipCapClause`, which is how the operator's value actually reaches the session. Omitted for a
	 * role that holds no lanes (every bridge), whose boot turn then carries no cap sentence.
	 */
	readonly wipCap?: WipCap | undefined;
	/** The resolved channels dimension of the crew `LaunchConfig` (#3293), consumed read-only. */
	readonly channels: ChannelConfig;
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
 * The crew channel is not named in the channel flag, so it would come up INERT (a persisted-scope entry
 * or a plugin declaration alone is insufficient — the flag is what activates the channel). Refuse the
 * launch. `requiredRef` is the ref the configured mode needs — `plugin:<name>@<marketplace>` under
 * allowlist, `server:<serverName>` under development — so the operator is told the exact missing line.
 */
export class CrewServerNotRegisteredError extends Schema.TaggedErrorClass<CrewServerNotRegisteredError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewServerNotRegisteredError",
	{
		requiredRef: Schema.String,
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

/**
 * The PLUGIN NAME of a `plugin:<name>@<marketplace>` channel ref — the key the allowlist is matched on.
 *
 * The `@<marketplace>` suffix must be stripped, and the old `split(":")[1]` did not strip it: it yielded
 * `"<name>@<marketplace>"`, which no `allowedChannelPlugins` entry ever equals, so every plugin ref was
 * spuriously rejected. Grounded on the installed bundle (2.1.220), whose allowlist gate parses the ref to
 * `{name, marketplace}` and matches `entry.plugin === name && entry.marketplace === marketplace` — the
 * name is the un-suffixed segment. (The distinct `plugin:<plugin>:<server>` colon grammar in the bundle
 * is MCP-server identity WITHIN a plugin, a different surface from this `--channels` ref; #3328.)
 */
const pluginOf = (ref: string): string | undefined =>
	ref.startsWith("plugin:") ? ref.slice("plugin:".length).split("@")[0] : undefined;

/**
 * Build one crew session's launch bind: the channel-registration flag, the mode-appropriate
 * `channelBinding` it names, and the pane env that binding needs. Fails closed if the crew channel
 * would be inert (its required ref unnamed in the flag), or — under `--channels` only — if a FOREIGN
 * plugin channel names a plugin outside `allowedChannelPlugins`.
 */
export const buildSessionBind = (
	input: SessionBindInput,
): Effect.Effect<
	SessionBind,
	CrewSessionBinUnresolvableError | CrewServerNotRegisteredError | ChannelPluginNotAllowedError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		// The platform is the swappable seam (.patterns/effect-platform-access.md): `FileSystem` probes
		// bin.ts resolvability (a `unit` test substitutes a fake FS instead of the old injected `binExists`),
		// and `Path` builds the plugin dir. Both discharge from the crew-mcp bin's existing NodeServices.layer.
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const {role, projectRoot, serverName, instance, tier, wipCap, channels} = input;
		const servers = channels.servers;

		// Resolvability before anything else: the bin the server command runs must exist on disk, else
		// the launched `<node> <bin.ts>` fails to spawn and the channel is inert (#3425). A probe fault
		// folds to "absent" (`orElseSucceed(false)`) so an fs error fails the launch closed under the
		// existing named error, never leaking a `PlatformError` — matching the old `existsSync` (false on
		// any fault), so this reader's E channel stays exactly its three launch-refusal errors.
		const binExists = yield* fs
			.exists(CREW_SESSION_BIN_PATH)
			.pipe(Effect.orElseSucceed(() => false));
		if (!binExists) {
			return yield* Effect.fail(
				new CrewSessionBinUnresolvableError({binPath: CREW_SESSION_BIN_PATH}),
			);
		}

		// The required ref — and therefore the whole binding shape — forks on the mode. Allowlist mode
		// CANNOT use `server:<name>`: config.ts's cross-field check already refuses a bare `server:` ref
		// there (the CLI silently skips one under `--channels`), so demanding the plugin ref is the only
		// registration that can actually come up (#3920).
		const requiredRef =
			channels.mode === "allowlist" ? CREW_PLUGIN_CHANNEL_REF : crewServerRef(serverName);
		if (!servers.includes(requiredRef)) {
			return yield* Effect.fail(new CrewServerNotRegisteredError({requiredRef, servers}));
		}

		// The allowlist gate applies to `--channels` only: dev mode's whole purpose is loading
		// channels NOT on the approved allowlist, so it deliberately skips the plugin check. The crew's
		// OWN plugin is auto-allowlisted — the launcher is the thing emitting that ref, so requiring the
		// operator to also list it in `allowedChannelPlugins` would only add a way to mis-configure a
		// launch that is otherwise fully determined. A FOREIGN plugin ref still fails closed.
		if (channels.mode === "allowlist") {
			for (const ref of servers) {
				const plugin = pluginOf(ref);
				if (
					plugin !== undefined &&
					plugin !== CREW_CHANNEL_PLUGIN &&
					!channels.allowedChannelPlugins.includes(plugin)
				) {
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
		// Allowlist mode binds the plugin's ONE static declaration and writes nothing; dev mode binds the
		// per-pane project-scope server whose argv carries the role. Symmetrically, the pane env is the
		// plugin path's per-pane role carrier and is empty in dev, where argv already carries it.
		const channelBinding: ChannelBinding =
			channels.mode === "allowlist"
				? {kind: "plugin-channel", ref: CREW_PLUGIN_CHANNEL_REF}
				: {
						kind: "project-scope",
						serverName,
						serverConfig: sessionServerConfig(role, projectRoot, instance),
					};
		const env: Readonly<Record<string, string>> =
			channels.mode === "allowlist"
				? {
						[CREW_ROLE_ENV]: role,
						[CREW_PROJECT_ROOT_ENV]: projectRoot,
						...(instance !== undefined ? {[CREW_INSTANCE_ENV]: instance} : {}),
					}
				: {};
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
		const pluginDirArg: readonly [string, string] = [
			PLUGIN_DIR_FLAG,
			path.join(projectRoot, CREW_PLUGIN_SUBDIR),
		];
		const agentArg: readonly [string, string] = [AGENT_FLAG, `crew-${role}`];
		// The launcher's boot turn (#3516): a tail positional prompt so the spawned session fires its
		// def's cold-start instead of idling. Tail placement (after the non-variadic --name) keeps it out
		// of the variadic channel option's reach; no -p/--print keeps the session interactive to self-drain.
		// A HITL role (the cartographer) gets NO boot turn — "start your loop under your own power" makes a
		// role with no standing loop confabulate work, so it boots idle instead (#3524). The drive is a
		// roster law, derived here (not a per-launch input like tier), so a HITL role can never be handed
		// the self-driving prompt on any launch path — autoboot or the on-demand spawn. A non-roster role
		// (never expected) defaults self-driving, preserving today's boot-turn behavior.
		// A configured cap rides the boot turn as one appended sentence (#4330) — the session-facing
		// delivery of the value the def defers to. Still exactly one positional, so the argv shape is
		// unchanged. A HITL role takes no boot turn at all, and so takes no cap with it.
		const selfDriving = !isCrewRole(role) || driveOf(role) === "self-driving";
		const bootTurn =
			wipCap !== undefined ? `${BOOT_PROMPT}\n\n${wipCapClause(wipCap)}` : BOOT_PROMPT;
		const bootPromptArg: readonly [] | readonly [string] = selfDriving ? [bootTurn] : [];

		return {
			role,
			projectRoot,
			channelBinding,
			env,
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
