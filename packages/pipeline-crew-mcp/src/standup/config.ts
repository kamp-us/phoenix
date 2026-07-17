/**
 * standup/config — the launch-dimension schema + typed reader for the stand-up launcher.
 *
 * The distributable pipeline-crew plugin ships ZERO operator data (the personalization
 * seam, claude-plugins/pipeline-crew/PERSONALIZATION.md), so every launch input the
 * stand-up reads — the pinned CLI version, the channel registration mode + server refs,
 * the engine count — enters through the operator-owned crew config. This module is the
 * decode boundary that turns that untrusted JSONC into the typed `LaunchConfig` the
 * version-assert, bind-builder, roster, and orchestration children consume; consuming the
 * values is out of scope here (issue #3293, decision on #3292).
 *
 * The one non-obvious thing: the reader FAILS CLOSED. A missing or malformed launch
 * dimension is a `LaunchConfigError` naming the offending dimension, never a silent default
 * — a drifted CLI pin or an unlisted channel server is a launch to refuse, not paper over.
 * Excess keys (operator, tmux, modelTiers, …) are ignored: this schema extracts only the
 * launch dimensions from the full crew config, so it composes with the rest of the seam.
 */
import {readFileSync} from "node:fs";
import {Effect, Schema} from "effect";

/**
 * A channel-server ref, in the launcher's registration grammar:
 *   - `server:<name>`            — a top-level channel MCP server
 *   - `plugin:<plugin>:<server>` — a server contributed by a plugin
 * The two forms are exactly what the bind-builder (#3296) turns into `--channels` args.
 */
export const CHANNEL_SERVER_REF_RE = /^(?:server:[^:\s]+|plugin:[^:\s]+:[^:\s]+)$/;

export const ChannelServerRef = Schema.String.check(
	Schema.isPattern(CHANNEL_SERVER_REF_RE, {
		title: "ChannelServerRef",
		description: 'a channel-server ref: "server:<name>" or "plugin:<plugin>:<server>"',
	}),
);
export type ChannelServerRef = typeof ChannelServerRef.Type;

/**
 * The pinned Claude Code CLI version the stand-up asserts before launching any session
 * (#3295 consumes it). A `major.minor.patch` core with an optional pre-release suffix — the
 * shape `claude --version` reports — so a non-version placeholder or a partial pin is rejected.
 */
export const CLI_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export const CliVersion = Schema.String.check(
	Schema.isPattern(CLI_VERSION_RE, {
		title: "CliVersion",
		description: "a pinned Claude Code CLI version, e.g. 2.1.207",
	}),
);
export type CliVersion = typeof CliVersion.Type;

/**
 * How each launched session registers its channel MCP servers:
 *   - `allowlist`   → `--channels <refs>` (only the listed servers load)
 *   - `development` → `--dangerously-load-development-channels` (every dev channel; local only)
 */
export const ChannelMode = Schema.Literals(["allowlist", "development"]);
export type ChannelMode = typeof ChannelMode.Type;

/** How many engine (build) sessions the stand-up starts — at least one. */
export const EngineCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1, {
		title: "EngineCount",
		description: "the number of engine sessions to start (>= 1)",
	}),
);
export type EngineCount = typeof EngineCount.Type;

/** The channel-registration dimension: the mode, the servers each session registers, and the plugin allowlist. */
export const ChannelConfig = Schema.Struct({
	mode: ChannelMode,
	servers: Schema.NonEmptyArray(ChannelServerRef),
	allowedChannelPlugins: Schema.Array(Schema.NonEmptyString),
});
export type ChannelConfig = typeof ChannelConfig.Type;

/** The launch dimensions the stand-up reads — the clean type every launcher child imports. */
export const LaunchConfig = Schema.Struct({
	cliVersion: CliVersion,
	engineCount: EngineCount,
	channels: ChannelConfig,
});
export type LaunchConfig = typeof LaunchConfig.Type;

/** A crew config that could not be resolved, read, parsed, or validated — carries the offending dimension. */
export class LaunchConfigError extends Schema.TaggedErrorClass<LaunchConfigError>()(
	"@kampus/pipeline-crew-mcp/standup/LaunchConfigError",
	{
		configPath: Schema.String,
		reason: Schema.String,
	},
) {}

/** The default operator-owned config path when `$CREW_CONFIG` is unset (ADR 0062 / PERSONALIZATION.md). */
export const DEFAULT_CONFIG_PATH = ".claude/crew.config.jsonc";

/** Resolve the config path: `$CREW_CONFIG` if set and non-blank, else `.claude/crew.config.jsonc`. */
export const resolveConfigPath = (
	env: {readonly CREW_CONFIG?: string | undefined} = process.env,
): string => {
	const override = env.CREW_CONFIG?.trim();
	return override && override.length > 0 ? override : DEFAULT_CONFIG_PATH;
};

/**
 * Strip JSONC to strict JSON: line/block comments and trailing commas. String-literal aware,
 * so a `//`, `/*`, or comma inside a string value is preserved — the template is `.jsonc`, so
 * the reader must handle the comments the operator keeps, not choke on them.
 */
export const stripJsonc = (text: string): string => {
	let out = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out += ch;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\") {
				// Copy the escaped char verbatim so an escaped quote can't end the string early.
				out += next ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		out += ch;
	}
	// Drop trailing commas (`,]` / `,}`), now that string bodies are safely behind us.
	return out.replace(/,(\s*[}\]])/g, "$1");
};

/** Parse operator JSONC into an untyped value; throws on malformed JSON (the reader maps it to a typed error). */
export const parseJsonc = (text: string): unknown => JSON.parse(stripJsonc(text));

/**
 * Decode an already-parsed value into `LaunchConfig`, failing closed with a `LaunchConfigError`
 * whose `reason` names the offending dimension (the schema issue tree carries the field path).
 */
export const decodeLaunchConfig = (
	input: unknown,
	configPath: string,
): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	Schema.decodeUnknownEffect(LaunchConfig)(input).pipe(
		Effect.mapError((error) => new LaunchConfigError({configPath, reason: error.message})),
	);

/**
 * Resolve → read → parse → decode the crew config's launch dimensions. Every failure along the
 * way (path unreadable, JSONC malformed, a dimension missing/invalid) collapses to a single
 * `LaunchConfigError` carrying the resolved path and the reason — never a partial or a default.
 */
export const readLaunchConfig = (
	env: {readonly CREW_CONFIG?: string | undefined} = process.env,
): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	Effect.gen(function* () {
		const configPath = resolveConfigPath(env);
		const text = yield* Effect.try({
			try: () => readFileSync(configPath, "utf8"),
			catch: (cause) =>
				new LaunchConfigError({
					configPath,
					reason: `cannot read crew config (run pipeline-crew stand-up first): ${String(cause)}`,
				}),
		});
		const parsed = yield* Effect.try({
			try: () => parseJsonc(text),
			catch: (cause) =>
				new LaunchConfigError({configPath, reason: `invalid JSONC: ${String(cause)}`}),
		});
		return yield* decodeLaunchConfig(parsed, configPath);
	});
