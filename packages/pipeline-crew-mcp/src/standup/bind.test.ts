/**
 * The per-session bind constructor (AC 1–4): for a role + project root it emits the launch
 * fragment each crew session comes up with — the per-invocation `--mcp-config` inline JSON baking
 * `pipeline-crew-mcp session --role <role> --project-root <root>`, plus the channel-registration
 * flag naming that same server. The tests pin the EXACT argv/JSON for a sample role in both channel
 * modes (allowlist → `--channels`, development → `--dangerously-load-development-channels`), and the
 * two fail-closed rejections: a crew server absent from the flag (defined-but-inert), and an
 * allowlist-mode plugin channel whose plugin the config's `allowedChannelPlugins` doesn't list.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	ALLOWLIST_CHANNEL_FLAG,
	buildSessionBind,
	ChannelPluginNotAllowedError,
	CREW_SESSION_COMMAND,
	CREW_SESSION_INSTANCE_FLAG,
	CrewServerNotRegisteredError,
	DEV_CHANNEL_FLAG,
	MCP_CONFIG_FLAG,
	PIPELINE_CREW_MCP_BIN,
} from "./bind.ts";
import type {ChannelConfig} from "./config.ts";

const ROLE = "engineering-manager";
const PROJECT_ROOT = "/work/phoenix";
const SERVER_NAME = "pipeline-crew";

// The exact inline JSON the --mcp-config value must carry: one server, keyed by the session's own
// channel-server name, whose command bakes the per-invocation `session --role --project-root`.
const EXPECTED_MCP_JSON = JSON.stringify({
	mcpServers: {
		[SERVER_NAME]: {
			command: PIPELINE_CREW_MCP_BIN,
			args: ["session", "--role", ROLE, "--project-root", PROJECT_ROOT],
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
							command: PIPELINE_CREW_MCP_BIN,
							args: [
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
