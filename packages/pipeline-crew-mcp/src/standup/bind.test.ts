/**
 * The per-session bind constructor (AC 1–4): for a role + project root it emits the launch inputs
 * each crew session comes up with — the crew server's PERSISTED-scope config value (`serverConfig`,
 * which the launcher writes into `~/.claude.json` local scope, #3444) plus the channel-registration
 * flag naming that same server. The tests pin the exact server config + argv for a sample role in both
 * channel modes (allowlist → `--channels`, development → `--dangerously-load-development-channels`),
 * that the argv NO LONGER carries `--mcp-config` (the resolver never read it, #3444), and the two
 * fail-closed rejections: a crew server absent from the flag (defined-but-inert), and an
 * allowlist-mode plugin channel whose plugin the config's `allowedChannelPlugins` doesn't list.
 */
import {existsSync} from "node:fs";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	ALLOWLIST_CHANNEL_FLAG,
	buildSessionBind,
	ChannelPluginNotAllowedError,
	CREW_SESSION_BIN_PATH,
	CREW_SESSION_COMMAND,
	CREW_SESSION_INSTANCE_FLAG,
	type CrewServerConfig,
	CrewServerNotRegisteredError,
	CrewSessionBinUnresolvableError,
	DEV_CHANNEL_FLAG,
	MODEL_FLAG,
	NAME_FLAG,
} from "./bind.ts";
import type {ChannelConfig} from "./config.ts";

const ROLE = "engineering-manager";
const PROJECT_ROOT = "/work/phoenix";
const SERVER_NAME = "pipeline-crew";

// The exact persisted-scope server config the launcher writes to `~/.claude.json` local scope: the
// launcher's own node (`process.execPath`) running the ABSOLUTE bin.ts path — a resolvable invocation,
// never the bare unlinked package bin name (#3425).
const EXPECTED_SERVER_CONFIG: CrewServerConfig = {
	command: process.execPath,
	args: [CREW_SESSION_BIN_PATH, "session", "--role", ROLE, "--project-root", PROJECT_ROOT],
};

describe("standup/bind — per-session bind constructor", () => {
	it.effect(
		"allowlist mode: persisted-scope serverConfig + --channels naming the crew server, NO inline --mcp-config (AC 1,2,3; #3444)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: ["server:pipeline-crew", "plugin:kampus:sozluk"],
					allowedChannelPlugins: ["kampus"],
				};
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				// AC1: the crew server is exposed as its persisted-scope config value, keyed by the server name.
				assert.strictEqual(bind.serverName, SERVER_NAME);
				assert.deepStrictEqual(bind.serverConfig, EXPECTED_SERVER_CONFIG);
				assert.strictEqual(CREW_SESSION_COMMAND, "session");

				// AC3: allowlist mode selects --channels over the config's server refs (grammar preserved).
				assert.deepStrictEqual(bind.channelArg, [
					ALLOWLIST_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:kampus:sozluk",
				]);

				// AC2: the argv registers the channel + closes with the visible name (#3443) and carries NO
				// `--mcp-config` — the crew server now registers via the persisted local scope (#3444).
				assert.deepStrictEqual(bind.argv, [
					ALLOWLIST_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:kampus:sozluk",
					NAME_FLAG,
					ROLE,
				]);
				assert.notInclude(bind.argv, "--mcp-config");
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
					servers: ["server:pipeline-crew", "plugin:localdev:scratch"],
					allowedChannelPlugins: [],
				};
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				assert.deepStrictEqual(bind.serverConfig, EXPECTED_SERVER_CONFIG);
				assert.deepStrictEqual(bind.channelArg, [
					DEV_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:localdev:scratch",
				]);
				assert.deepStrictEqual(bind.argv, [...bind.channelArg, ...bind.nameArg]);
			}),
	);

	it.effect(
		"fails closed when the crew server is absent from the channel flag (defined-but-inert)",
		() =>
			Effect.gen(function* () {
				const channels: ChannelConfig = {
					mode: "allowlist",
					servers: ["server:some-other"],
					allowedChannelPlugins: [],
				};
				const error = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				}).pipe(Effect.flip);

				assert.instanceOf(error, CrewServerNotRegisteredError);
				assert.strictEqual(error.serverName, SERVER_NAME);
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
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: INSTANCE,
					channels,
				});

				// the instance flag + id ride the persisted-scope server command, after --project-root.
				assert.deepStrictEqual(bind.serverConfig, {
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
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.notInclude([...bind.serverConfig.args], CREW_SESSION_INSTANCE_FLAG);
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
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});

				const server = bind.serverConfig;
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
				const error = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
					// The injected resolvability probe reports the bin absent — the launch must refuse.
					binExists: () => false,
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
			const bind = yield* buildSessionBind({
				role: ROLE,
				projectRoot: PROJECT_ROOT,
				serverName: SERVER_NAME,
				tier: "opus",
				channels,
			});
			// The tier boots the session's model — a family tier is a verbatim --model alias (config.ts
			// Tier, grounded on the 2.1.212 bundle), so tier:opus yields `--model opus`.
			assert.deepStrictEqual([...bind.modelArg], [MODEL_FLAG, "opus"]);
			// --model leads the argv; the channel fragment follows it, then the name (#3443). No --mcp-config.
			assert.deepStrictEqual(
				[...bind.argv],
				[MODEL_FLAG, "opus", ...bind.channelArg, ...bind.nameArg],
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
				const bind = yield* buildSessionBind({
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
				const bind = yield* buildSessionBind({
					role: ROLE,
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.deepStrictEqual([...bind.modelArg], []);
				assert.notInclude(bind.argv, MODEL_FLAG);
				// No tier ⇒ no --model; argv is the channel fragment closed by the name (#3443).
				assert.deepStrictEqual([...bind.argv], [...bind.channelArg, ...bind.nameArg]);
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
				const bind = yield* buildSessionBind({
					role: "chief-of-staff",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					channels,
				});
				assert.deepStrictEqual([...bind.nameArg], [NAME_FLAG, "chief-of-staff"]);
				// the name flag rides the tail of the argv, after the channel fragment.
				assert.deepStrictEqual([...bind.argv].slice(-2), [NAME_FLAG, "chief-of-staff"]);
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
				const engineOne = yield* buildSessionBind({
					role: "engineering-manager",
					projectRoot: PROJECT_ROOT,
					serverName: SERVER_NAME,
					instance: "e-1",
					channels,
				});
				const engineTwo = yield* buildSessionBind({
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

	it.effect("allowlist mode fails closed on a plugin channel whose plugin is not allowlisted", () =>
		Effect.gen(function* () {
			const channels: ChannelConfig = {
				mode: "allowlist",
				servers: ["server:pipeline-crew", "plugin:untrusted:evil"],
				allowedChannelPlugins: ["kampus"],
			};
			const error = yield* buildSessionBind({
				role: ROLE,
				projectRoot: PROJECT_ROOT,
				serverName: SERVER_NAME,
				channels,
			}).pipe(Effect.flip);

			assert.instanceOf(error, ChannelPluginNotAllowedError);
			assert.strictEqual(error.plugin, "untrusted");
			assert.strictEqual(error.ref, "plugin:untrusted:evil");
			assert.deepStrictEqual([...error.allowedChannelPlugins], ["kampus"]);
		}),
	);
});
