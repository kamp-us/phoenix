/**
 * The per-session bind constructor (AC 1–4): for a role + project root it emits the launch
 * fragment each crew session comes up with — the per-invocation `--mcp-config` inline JSON baking
 * `pipeline-crew-mcp session --role <role> --project-root <root>`, plus the channel-registration
 * flag naming that same server. The tests pin the EXACT argv/JSON for a sample role in both channel
 * modes (allowlist → `--channels`, development → `--dangerously-load-development-channels`), and the
 * two fail-closed rejections: a crew server absent from the flag (defined-but-inert), and an
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
	CrewServerNotRegisteredError,
	CrewSessionBinUnresolvableError,
	DEV_CHANNEL_FLAG,
	MCP_CONFIG_FLAG,
	MODEL_FLAG,
} from "./bind.ts";
import type {ChannelConfig} from "./config.ts";

const ROLE = "engineering-manager";
const PROJECT_ROOT = "/work/phoenix";
const SERVER_NAME = "pipeline-crew";

// The exact inline JSON the --mcp-config value must carry: one server, keyed by the session's own
// channel-server name, whose command is the launcher's own node (`process.execPath`) running the
// ABSOLUTE bin.ts path — a resolvable invocation, never the bare unlinked package bin name (#3425).
const EXPECTED_MCP_JSON = JSON.stringify({
	mcpServers: {
		[SERVER_NAME]: {
			command: process.execPath,
			args: [CREW_SESSION_BIN_PATH, "session", "--role", ROLE, "--project-root", PROJECT_ROOT],
		},
	},
});

describe("standup/bind — per-session bind constructor", () => {
	it.effect(
		"allowlist mode: --mcp-config inline JSON + --channels naming the crew server (AC 1,2,3)",
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

				// AC1: the --mcp-config value is the exact inline JSON baking the session command.
				assert.deepStrictEqual(bind.mcpConfigArg, [MCP_CONFIG_FLAG, EXPECTED_MCP_JSON]);
				assert.strictEqual(CREW_SESSION_COMMAND, "session");

				// AC3: allowlist mode selects --channels over the config's server refs (grammar preserved).
				assert.deepStrictEqual(bind.channelArg, [
					ALLOWLIST_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:kampus:sozluk",
				]);

				// AC2: the full argv carries BOTH — the crew server is named in the flag, never .mcp.json alone.
				assert.deepStrictEqual(bind.argv, [
					MCP_CONFIG_FLAG,
					EXPECTED_MCP_JSON,
					ALLOWLIST_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:kampus:sozluk",
				]);
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

				assert.deepStrictEqual(bind.mcpConfigArg, [MCP_CONFIG_FLAG, EXPECTED_MCP_JSON]);
				assert.deepStrictEqual(bind.channelArg, [
					DEV_CHANNEL_FLAG,
					"server:pipeline-crew",
					"plugin:localdev:scratch",
				]);
				assert.deepStrictEqual(bind.argv, [MCP_CONFIG_FLAG, EXPECTED_MCP_JSON, ...bind.channelArg]);
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
		"bakes the launcher-assigned per-instance identity into the session argv (seam 3, #3354)",
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

				// the instance flag + id ride the inline --mcp-config server command, after --project-root.
				const expected = JSON.stringify({
					mcpServers: {
						[SERVER_NAME]: {
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
						},
					},
				});
				assert.deepStrictEqual(bind.mcpConfigArg, [MCP_CONFIG_FLAG, expected]);
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
				assert.notInclude(bind.mcpConfigArg[1], CREW_SESSION_INSTANCE_FLAG);
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

				const server = JSON.parse(bind.mcpConfigArg[1]).mcpServers[SERVER_NAME];
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
			// --model leads the argv; the #3425 mcp-config + channel fragment follows it unchanged.
			assert.deepStrictEqual(
				[...bind.argv],
				[MODEL_FLAG, "opus", ...bind.mcpConfigArg, ...bind.channelArg],
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
				// argv is exactly the pre-#3423 fragment when no tier is set.
				assert.deepStrictEqual([...bind.argv], [...bind.mcpConfigArg, ...bind.channelArg]);
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
