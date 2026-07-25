/**
 * The per-session bind constructor: for a role + project root it emits the launch inputs each crew
 * session comes up with — the channel-registration flag, the mode-appropriate `channelBinding` it names,
 * and the pane env that binding needs. The tests pin both launch paths end to end:
 *   - allowlist/production (#3920) → `--channels` naming the `plugin:<name>@<marketplace>` crew ref, a
 *     `plugin-channel` binding that persists NOTHING, and the per-pane `CREW_ROLE`/`CREW_PROJECT_ROOT`/
 *     `CREW_INSTANCE` env the plugin's one static declaration resolves through;
 *   - development (#3444, unchanged) → `--dangerously-load-development-channels`, a `project-scope`
 *     binding carrying the role-baked server config, and an EMPTY pane env.
 * Plus the fail-closed rejections: an unresolvable bin, a crew channel absent from the flag in either
 * mode (defined-but-inert — the required ref differs per mode), and a FOREIGN allowlist-mode plugin
 * channel the config's `allowedChannelPlugins` doesn't list (the crew's own plugin is auto-allowlisted).
 */
import {existsSync} from "node:fs";
import {NodePath, NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Layer} from "effect";
import {
	AGENT_FLAG,
	ALLOWLIST_CHANNEL_FLAG,
	BOOT_PROMPT,
	buildSessionBind,
	ChannelPluginNotAllowedError,
	CREW_PLUGIN_CHANNEL_REF,
	CREW_SESSION_BIN_PATH,
	CREW_SESSION_COMMAND,
	CREW_SESSION_INSTANCE_FLAG,
	type CrewServerConfig,
	CrewServerNotRegisteredError,
	CrewSessionBinUnresolvableError,
	DEV_CHANNEL_FLAG,
	MODEL_FLAG,
	NAME_FLAG,
	PLUGIN_DIR_FLAG,
	type SessionBind,
} from "./bind.ts";
import type {ChannelConfig} from "./config.ts";

const ROLE = "engineering-manager";
const PROJECT_ROOT = "/work/phoenix";
const SERVER_NAME = "pipeline-crew";

/**
 * Narrow a bind to its `project-scope` binding, failing the test if it took the plugin path. Only dev
 * mode persists a server config, so every assertion about one goes through here rather than a cast.
 */
const projectScopeOf = (bind: SessionBind) => {
	const binding = bind.channelBinding;
	if (binding.kind !== "project-scope") {
		throw new Error(`expected a project-scope binding, got "${binding.kind}"`);
	}
	return binding;
};

// The bind constructor reaches the platform through the `FileSystem`/`Path` seam
// (.patterns/effect-platform-access.md), discharged in-test by the same NodeServices.layer the bin
// provides — so `build` is the real-disk variant (bin.ts resolves), matching production.
const build = (input: Parameters<typeof buildSessionBind>[0]) =>
	buildSessionBind(input).pipe(Effect.provide(NodeServices.layer));

// The seam is what makes the "bin absent" guard testable WITHOUT the old injected `binExists`: a fake
// `FileSystem` whose `exists` answers false (the whole filesystem substituted, not just a probe fn).
const buildWithBinAbsent = (input: Parameters<typeof buildSessionBind>[0]) =>
	buildSessionBind(input).pipe(
		Effect.provide(
			Layer.mergeAll(FileSystem.layerNoop({exists: () => Effect.succeed(false)}), NodePath.layer),
		),
	);
// The pipeline-crew plugin root under PROJECT_ROOT — the dir `--plugin-dir` loads the role agent-defs
// from so `--agent <role>` resolves the persona instead of general-purpose (#3447).
const EXPECTED_PLUGIN_DIR = "/work/phoenix/claude-plugins/pipeline-crew";

// The exact persisted-scope server config the launcher writes to `~/.claude.json` local scope: the
// launcher's own node (`process.execPath`) running the ABSOLUTE bin.ts path — a resolvable invocation,
// never the bare unlinked package bin name (#3425).
const EXPECTED_SERVER_CONFIG: CrewServerConfig = {
	command: process.execPath,
	args: [CREW_SESSION_BIN_PATH, "session", "--role", ROLE, "--project-root", PROJECT_ROOT],
};

describe("standup/bind — per-session bind constructor", () => {
	it.effect(
		"allowlist mode: binds the crew PLUGIN channel ref, persists nothing, and carries the per-pane env (#3920)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: [CREW_PLUGIN_CHANNEL_REF, "plugin:sozluk@kampus"],
					allowedChannelPlugins: ["sozluk"],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				// The crew channel binds by the plugin's own static declaration — the launcher writes NO
				// per-pane `.mcp.json` on this path, so there is no server config to persist at all.
				assert.deepStrictEqual(bind.channelBinding, {
					kind: "plugin-channel",
					ref: CREW_PLUGIN_CHANNEL_REF,
				});
				assert.strictEqual(CREW_SESSION_COMMAND, "session");

				// The role the one shared declaration can't carry travels as pane env instead (#3366).
				assert.deepStrictEqual(bind.env, {
					CREW_ROLE: ROLE,
					CREW_PROJECT_ROOT: PROJECT_ROOT,
				});

				// allowlist mode selects --channels over the config's refs (grammar preserved verbatim).
				assert.deepStrictEqual(bind.channelArg, [
					ALLOWLIST_CHANNEL_FLAG,
					CREW_PLUGIN_CHANNEL_REF,
					"plugin:sozluk@kampus",
				]);

				// The argv boots the role persona (--plugin-dir + --agent, #3447), registers the channel,
				// carries the visible name (#3443), closes with the positional boot-turn prompt (#3516), and
				// carries neither `--mcp-config` nor a `--role` — role is env on this path.
				assert.deepStrictEqual(bind.argv, [
					PLUGIN_DIR_FLAG,
					EXPECTED_PLUGIN_DIR,
					AGENT_FLAG,
					`crew-${ROLE}`,
					ALLOWLIST_CHANNEL_FLAG,
					CREW_PLUGIN_CHANNEL_REF,
					"plugin:sozluk@kampus",
					NAME_FLAG,
					ROLE,
					BOOT_PROMPT,
				]);
				assert.notInclude(bind.argv, "--mcp-config");
				assert.notInclude(bind.argv, "--role");
			}),
	);

	it.effect(
		"allowlist mode: an engine's instance rides the pane env as CREW_INSTANCE (#3920)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: [CREW_PLUGIN_CHANNEL_REF],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: "e-1",
					channels,
				});
				assert.deepStrictEqual(bind.env, {
					CREW_ROLE: ROLE,
					CREW_PROJECT_ROOT: PROJECT_ROOT,
					CREW_INSTANCE: "e-1",
				});
			}),
	);

	it.effect(
		"allowlist mode auto-allowlists the crew's OWN plugin — the operator need not list it (#3920)",
		() =>
			Effect.gen(function* () {
				// `allowedChannelPlugins` is empty, yet the crew's own plugin ref binds: the launcher is the
				// thing emitting that ref, so requiring the operator to also declare it would only add a way
				// to mis-configure an otherwise fully determined launch.
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: [CREW_PLUGIN_CHANNEL_REF],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.strictEqual(bind.channelBinding.kind, "plugin-channel");
			}),
	);

	it.effect(
		"development mode: --dangerously-load-development-channels, allowlist gate skipped (AC 3)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					// A plugin channel whose plugin is NOT in allowedChannelPlugins — accepted in dev mode,
					// which is exactly the dev flag's purpose (load channels not on the approved allowlist).
					servers: ["server:pipeline-crew", "plugin:localdev@scratch"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				assert.deepStrictEqual(projectScopeOf(bind), {
					kind: "project-scope",
					serverName: SERVER_NAME,
					serverConfig: EXPECTED_SERVER_CONFIG,
				});
				// Dev's server argv already carries the role, so the pane env stays EMPTY — the dev spawn is
				// byte-identical to before the plugin-channel seam existed.
				assert.deepStrictEqual(bind.env, {});
				assert.deepStrictEqual(bind.channelArg, [
					DEV_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:localdev@scratch",
				]);
				assert.deepStrictEqual(bind.argv, [
					...bind.pluginDirArg,
					...bind.agentArg,
					...bind.channelArg,
					...bind.nameArg,
					...bind.bootPromptArg,
				]);
			}),
	);

	it.effect(
		"boots each pane AS its role persona: --plugin-dir <crew plugin> + --agent crew-<role>, collision-free (#3447)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				// Each role's --agent target is the collision-free `crew-<role>` plugin agent-def name (not
				// the bare role), so a personal `~/.claude/agents/<role>.md` def can't shadow it (#3447
				// Option B); the bare role stays the key everywhere else. --plugin-dir makes it resolvable.
				for (const role of [
					"chief-of-staff",
					"cartographer",
					"intake-desk",
					"engineering-manager",
				]) {
					const bind = yield* build({
						role,
						projectRoot: PROJECT_ROOT,
						serverName: SERVER_NAME,
						channels,
					});
					assert.deepStrictEqual([...bind.pluginDirArg], [PLUGIN_DIR_FLAG, EXPECTED_PLUGIN_DIR]);
					assert.deepStrictEqual([...bind.agentArg], [AGENT_FLAG, `crew-${role}`]);
					// the persona flags lead the argv (ahead of the channel fragment), after any --model.
					assert.deepStrictEqual([...bind.argv].slice(0, 4), [
						PLUGIN_DIR_FLAG,
						EXPECTED_PLUGIN_DIR,
						AGENT_FLAG,
						`crew-${role}`,
					]);
				}
			}),
	);

	it.effect("derives --plugin-dir from the project root (never a hardcoded/home path)", () =>
		Effect.gen(function* () {
			const channels: ChannelConfig = {
				mode: "development",
				servers: ["server:pipeline-crew"],
				allowedChannelPlugins: [],
			};
			const bind = yield* build({
				role: ROLE,
				projectRoot: "/some/other/root",
				serverName: SERVER_NAME,
				channels,
			});
			assert.deepStrictEqual(
				[...bind.pluginDirArg],
				[PLUGIN_DIR_FLAG, "/some/other/root/claude-plugins/pipeline-crew"],
			);
		}),
	);

	it.effect(
		"allowlist mode fails closed when the crew PLUGIN ref is absent from --channels (defined-but-inert)",
		() =>
			Effect.gen(function* () {
				// A bare `server:` ref cannot stand in for it here: the CLI silently skips one under
				// `--channels`, so the required ref in this mode is the plugin ref and nothing else (#3920).
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: ["plugin:some-other@kampus"],
					allowedChannelPlugins: ["some-other"],
				};
				const error = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				}).pipe(Effect.flip);

				assert.instanceOf(error, CrewServerNotRegisteredError);
				assert.strictEqual(error.requiredRef, CREW_PLUGIN_CHANNEL_REF);
				assert.deepStrictEqual([...error.servers], ["plugin:some-other@kampus"]);
			}),
	);

	it.effect(
		"development mode fails closed when the crew server: ref is absent from the dev flag (unchanged)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:some-other"],
					allowedChannelPlugins: [],
				};
				const error = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				}).pipe(Effect.flip);

				assert.instanceOf(error, CrewServerNotRegisteredError);
				assert.strictEqual(error.requiredRef, `server:${SERVER_NAME}`);
				assert.deepStrictEqual([...error.servers], ["server:some-other"]);
			}),
	);

	it.effect(
		"bakes the launcher-assigned per-instance identity into the session server config (seam 3, #3354)",
		() =>
			Effect.gen(function* () {
				const INSTANCE = "e-7f3a";
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: INSTANCE,
					channels,
				});

				// the instance flag + id ride the persisted-scope server command, after --project-root.
				assert.deepStrictEqual(projectScopeOf(bind).serverConfig, {
					command: process.execPath,
					args: [
						CREW_SESSION_BIN_PATH,
						CREW_SESSION_COMMAND,
						"--role",
						ROLE,
						"--project-root",
						PROJECT_ROOT,
						CREW_SESSION_INSTANCE_FLAG,
						INSTANCE,
					],
				});
			}),
	);

	it.effect(
		"omits the instance flag when no per-instance identity is given (a bridge singleton)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.notInclude([...projectScopeOf(bind).serverConfig.args], CREW_SESSION_INSTANCE_FLAG);
			}),
	);

	it.effect(
		"the bound server command is a RESOLVABLE invocation: node + an existing absolute bin.ts (#3425)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				const server = projectScopeOf(bind).serverConfig;
				// Not the old bare, unlinked package bin name — an absolute node + an absolute bin path.
				assert.strictEqual(server.command, process.execPath);
				assert.notStrictEqual(server.command, "pipeline-crew-mcp");
				assert.strictEqual(server.args[0], CREW_SESSION_BIN_PATH);
				assert.isTrue(CREW_SESSION_BIN_PATH.startsWith("/"), "bin path must be absolute");
				assert.match(CREW_SESSION_BIN_PATH, /bin\.ts$/);
				// The resolvable invocation actually resolves: the baked bin.ts exists on disk.
				assert.isTrue(existsSync(CREW_SESSION_BIN_PATH), "baked bin.ts must resolve on disk");
			}),
	);

	it.effect(
		"fails closed when the crew server bin.ts does not resolve on disk (the missing sibling guard, #3425)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const error = yield* buildWithBinAbsent({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
					// The substituted FileSystem reports the bin absent (exists → false) — the launch must refuse.
				}).pipe(Effect.flip);

				assert.instanceOf(error, CrewSessionBinUnresolvableError);
				assert.strictEqual(error.binPath, CREW_SESSION_BIN_PATH);
			}),
	);

	it.effect("emits --model <tier> at the front of the argv when the role has a tier (#3423)", () =>
		Effect.gen(function* () {
			const channels: ChannelConfig = {
				mode: "development",
				servers: ["server:pipeline-crew"],
				allowedChannelPlugins: [],
			};
			const bind = yield* build({
				role: ROLE,
				projectRoot: PROJECT_ROOT,
				serverName: SERVER_NAME,
				tier: "opus",
				channels,
			});
			// The tier boots the session's model — a family tier is a verbatim --model alias (config.ts
			// Tier, grounded on the 2.1.212 bundle), so tier:opus yields `--model opus`.
			assert.deepStrictEqual([...bind.modelArg], [MODEL_FLAG, "opus"]);
			// --model leads the argv; then the persona flags (#3447), the channel fragment, the name
			// (#3443), and the tail boot-turn prompt (#3516). No --mcp-config.
			assert.deepStrictEqual(
				[...bind.argv],
				[
					MODEL_FLAG,
					"opus",
					...bind.pluginDirArg,
					...bind.agentArg,
					...bind.channelArg,
					...bind.nameArg,
					...bind.bootPromptArg,
				],
			);
		}),
	);

	it.effect(
		"cartographer's tier:fable yields --model fable (the planning-tier bridge, #3423)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: "cartographer",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					tier: "fable",
					channels,
				});
				assert.deepStrictEqual([...bind.modelArg], [MODEL_FLAG, "fable"]);
			}),
	);

	it.effect(
		"emits NO --model when the role has no tier — preserves the CLI-default boot (#3423)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.deepStrictEqual([...bind.modelArg], []);
				assert.notInclude(bind.argv, MODEL_FLAG);
				// No tier ⇒ no --model; argv is the persona flags (#3447) + the channel fragment + the name
				// (#3443), closed by the tail boot-turn prompt (#3516).
				assert.deepStrictEqual(
					[...bind.argv],
					[
						...bind.pluginDirArg,
						...bind.agentArg,
						...bind.channelArg,
						...bind.nameArg,
						...bind.bootPromptArg,
					],
				);
			}),
	);

	it.effect(
		"emits --name <role> for a bridge (no instance) — the visible pane identity (#3443)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: "chief-of-staff",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.deepStrictEqual([...bind.nameArg], [NAME_FLAG, "chief-of-staff"]);
				// the name flag rides after the channel fragment, immediately before the tail boot-turn
				// prompt (#3516) — so it's the last-but-one pair, with BOOT_PROMPT at the very tail.
				assert.deepStrictEqual([...bind.argv].slice(-3), [
					NAME_FLAG,
					"chief-of-staff",
					BOOT_PROMPT,
				]);
			}),
	);

	it.effect(
		"engine sessions get --name <role>-<instance> so the N engine panes are distinctly named (AC2, #3443)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const engineOne = yield* build({
					role: "engineering-manager",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: "e-1",
					channels,
				});
				const engineTwo = yield* build({
					role: "engineering-manager",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: "e-2",
					channels,
				});
				assert.deepStrictEqual([...engineOne.nameArg], [NAME_FLAG, "engineering-manager-e-1"]);
				assert.deepStrictEqual([...engineTwo.nameArg], [NAME_FLAG, "engineering-manager-e-2"]);
				// the two engine panes come up with DISTINCT visible names, never two identical roles.
				assert.notStrictEqual(engineOne.nameArg[1], engineTwo.nameArg[1]);
			}),
	);

	it.effect(
		"hands the session its boot turn: a single positional prompt at the argv tail, no -p/--print (#3516)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				// The boot prompt is exactly one bare positional (no flag) carrying BOOT_PROMPT — that is
				// the CLI's `[prompt]` argument, which gives the spawned session its first turn so its def's
				// cold-start fires from boot instead of idling (#3516).
				assert.deepStrictEqual([...bind.bootPromptArg], [BOOT_PROMPT]);
				// It rides the very tail of the argv, after --name (the non-variadic option that stops the
				// variadic channel flag), so it lands as the positional prompt and isn't swallowed.
				assert.strictEqual(bind.argv[bind.argv.length - 1], BOOT_PROMPT);
				// Interactive, not headless: no -p/--print means the session runs this turn AND stays alive
				// to self-drain (grounded on CLI 2.1.214: interactive by default, -p/--print exits).
				assert.notInclude(bind.argv, "-p");
				assert.notInclude(bind.argv, "--print");
			}),
	);

	it.effect(
		"every SELF-DRIVING role (bridge + engine) gets the same role-agnostic boot turn (#3516)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				// A self-driving bridge (no instance) and an engine (with instance) both receive the boot
				// prompt — the def each boots as carries its own cold-start, so the launcher's turn is generic.
				const bridge = yield* build({
					role: "chief-of-staff",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				const engine = yield* build({
					role: "engineering-manager",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: "e-1",
					channels,
				});
				assert.deepStrictEqual([...bridge.bootPromptArg], [BOOT_PROMPT]);
				assert.deepStrictEqual([...engine.bootPromptArg], [BOOT_PROMPT]);
				assert.strictEqual(bridge.argv[bridge.argv.length - 1], BOOT_PROMPT);
				assert.strictEqual(engine.argv[engine.argv.length - 1], BOOT_PROMPT);
			}),
	);

	it.effect(
		"a human-in-the-loop role (the cartographer) gets NO boot turn — it boots idle (#3524)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "development",
					servers: ["server:pipeline-crew"],
					allowedChannelPlugins: [],
				};
				// The cartographer has no standing loop, so it must NOT be handed the self-driving BOOT_PROMPT
				// — that is what made it confabulate work. Even launched on-demand, its argv carries no
				// positional prompt, so the CLI opens an interactive session that idles waiting for the human.
				const bind = yield* build({
					role: "cartographer",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.deepStrictEqual([...bind.bootPromptArg], []);
				assert.notInclude(bind.argv, BOOT_PROMPT);
				// Interactive and idle: still no -p/--print (an interactive session), and the argv ends at the
				// visible --name pair rather than a boot-turn prompt — it waits for the human, not a loop.
				assert.notInclude(bind.argv, "-p");
				assert.notInclude(bind.argv, "--print");
				assert.deepStrictEqual([...bind.argv].slice(-2), [...bind.nameArg]);
			}),
	);

	it.effect(
		"allowlist mode fails closed on a FOREIGN plugin channel whose plugin is not allowlisted",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: [CREW_PLUGIN_CHANNEL_REF, "plugin:untrusted@elsewhere"],
					allowedChannelPlugins: ["sozluk"],
				};
				const error = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				}).pipe(Effect.flip);

				assert.instanceOf(error, ChannelPluginNotAllowedError);
				// The plugin key is the ref's name segment with the `@<marketplace>` suffix STRIPPED — the
				// key the CLI's allowlist actually matches on (a `<name>@<marketplace>` key never matches).
				assert.strictEqual(error.plugin, "untrusted");
				assert.strictEqual(error.ref, "plugin:untrusted@elsewhere");
				assert.deepStrictEqual([...error.allowedChannelPlugins], ["sozluk"]);
			}),
	);

	it.effect(
		"allowlist mode admits a foreign plugin the operator DID allowlist (by bare name)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: [CREW_PLUGIN_CHANNEL_REF, "plugin:sozluk@kampus"],
					allowedChannelPlugins: ["sozluk"],
				};
				const bind = yield* build({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.include(bind.channelArg, "plugin:sozluk@kampus");
			}),
	);
});
