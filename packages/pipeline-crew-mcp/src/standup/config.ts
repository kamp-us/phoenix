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
 * — an unlisted channel server or a bad engine count is a launch to refuse, not paper over.
 * The lone exception is `cliVersion`: it is OPTIONAL (issue #3417) — an omitted pin decodes
 * to an "unpinned" launch (the key is simply absent), so the crew boot stops fail-closing on
 * every frequent Claude Code auto-update; pin ONLY to deliberately lock a version. A pin that
 * IS present must still be a valid `CLI_VERSION_RE` version — a malformed present pin fails closed.
 * `LaunchConfig` extracts the launch dimensions from the one-role-map seam shape (ADR 0189): the
 * engine count is folded into `roles["engineering-manager"].count`, and each role's optional `tier`
 * — the session model, #3423 — is folded into `roleTiers`. Remaining seam keys
 * (operator/notification/wipCap/…) are ignored. There is no config-read tmux dimension —
 * tmux window placement now derives from role identity at launch (tmux-placement.ts), not config.
 */
import {readFileSync} from "node:fs";
import {Effect, Schema} from "effect";
import {CREW_ROLES} from "../crew/index.ts";

/**
 * A channel-server ref, in the exact registration grammar Claude Code 2.1.212 accepts —
 * grounded against the installed bundle's channel-tag parser, NOT intuited (CLAUDE.md's
 * "ground falsifiable runtime claims in source"; VERSION 2.1.212, GIT_SHA 8b2783a):
 *   - `server:<name>`             — a top-level channel MCP server
 *   - `plugin:<name>@<marketplace>` — a plugin-provided channel (allowlist enforced)
 *
 * The bundle's `--channels` tag loop parses a `plugin:` entry by splitting on `@`
 * (`let xl=mu.indexOf("@"); if(xl<=0||xl===mu.length-1) reject; else {name:mu.slice(0,xl),
 * marketplace:mu.slice(xl+1)}`) and its marketplace parser requires exactly two non-empty
 * parts (`split("@"); if(t.length!==2||!t[0]||!t[1]) return null`). So the OLD
 * `plugin:<plugin>:<server>` shape (#3293) — no `@` — is rejected by the real runtime; the
 * channel grammar is unambiguously `<name>@<marketplace>`. (The bundle's distinct
 * split-on-`:` `plugin:<plugin>:<server>` parser is MCP-server identity within a plugin — a
 * different surface from this `--channels` allowlist grammar.) See #3328.
 */
export const CHANNEL_PLUGIN_REF_RE = /^plugin:[^@\s]+@[^@\s]+$/;
export const CHANNEL_SERVER_REF_RE = /^(?:server:[^:\s]+|plugin:[^@\s]+@[^@\s]+)$/;

export const ChannelServerRef = Schema.String.check(
	Schema.isPattern(CHANNEL_SERVER_REF_RE, {
		title: "ChannelServerRef",
		description: 'a channel-server ref: "server:<name>" or "plugin:<name>@<marketplace>"',
	}),
);
export type ChannelServerRef = typeof ChannelServerRef.Type;

/** Whether a validated channel-server ref is a top-level `server:` ref (vs a `plugin:` ref). */
const isServerRef = (ref: string): boolean => ref.startsWith("server:");

/**
 * The pinned Claude Code CLI version the stand-up asserts before launching any session
 * (#3295 consumes it). A `major.minor.patch` core with an optional pre-release suffix — the
 * shape `claude --version` reports — so a non-version placeholder or a partial pin is rejected.
 * The pin itself is optional (issue #3417 — see `LaunchConfig.cliVersion`); this regex constrains
 * a pin only when one is PRESENT — an omitted pin never reaches it.
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

/**
 * A role's model tier — the operator's per-role cost/capability control (#3423), decoded so the
 * launcher can boot each session's `claude` on the tier's model (`--model <alias>`), not the CLI
 * default. The vocabulary is the set of "latest model family" aliases the installed Claude Code
 * CLI's `--model` flag accepts, grounded against the bundle NOT intuited (CLAUDE.md's "ground
 * falsifiable runtime claims in source"): the 2.1.212 `--model` help reads *"Provide an alias for
 * the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g.
 * 'claude-fable-5')"*, and its `resolveModelAlias` accepts `fable | haiku | opus | sonnet` (VERSION
 * 2.1.212, GIT_SHA 8b2783a). The `[1m]` / `opusplan` / `default` alias variants are deliberately
 * excluded — a crew tier names a model FAMILY, not a context-window or plan-mode combo. A malformed
 * tier decodes to a `LaunchConfigError` naming the `tier` path (fail-closed, no silent default).
 */
export const Tier = Schema.Literals(["opus", "sonnet", "haiku", "fable"]);
export type Tier = typeof Tier.Type;

/**
 * tier → the `claude --model` alias the launched session boots on. Each family tier is a verbatim
 * `--model` alias in the installed bundle (grounded on `Tier` above), so the map is identity today —
 * but it stays an explicit single-source seam so a future tier whose name diverges from its `--model`
 * alias is one edit here, never a scatter of string literals across the launcher (#3423).
 */
export const TIER_MODEL = {
	opus: "opus",
	sonnet: "sonnet",
	haiku: "haiku",
	fable: "fable",
} as const satisfies Record<Tier, string>;

/** The `--model <alias>` a tier boots the session on. Total over `Tier` by `TIER_MODEL`'s satisfies. */
export const tierModel = (tier: Tier): string => TIER_MODEL[tier];

/**
 * The channel-registration dimension: the mode, the servers each session registers, and the
 * plugin allowlist.
 *
 * The cross-field check makes the runtime-invalid combination unrepresentable at decode: a
 * top-level `server:` ref only registers via `--dangerously-load-development-channels` (which
 * alone sets the bundle's `dev` flag). 2.1.212's runtime validator SKIPS a non-dev `server:`
 * channel under `--channels` (`else if(!o.dev) return {action:"skip", ... "server <X> is not on
 * the approved channels allowlist (use --dangerously-load-development-channels for local dev)"}`,
 * VERSION 2.1.212, GIT_SHA 8b2783a). So an `allowlist` config carrying a `server:` ref would
 * name a channel the runtime silently drops — fail closed here instead (#3328).
 */
export const ChannelConfig = Schema.Struct({
	mode: ChannelMode,
	servers: Schema.NonEmptyArray(ChannelServerRef),
	allowedChannelPlugins: Schema.Array(Schema.NonEmptyString),
}).check(
	Schema.makeFilter((cfg) => {
		if (cfg.mode !== "allowlist") return undefined;
		const bare = cfg.servers.filter(isServerRef);
		return bare.length === 0
			? undefined
			: {
					path: ["servers"],
					issue: `allowlist mode registers channels via --channels, which loads only plugin:<name>@<marketplace> refs; a top-level server: ref (${bare.join(", ")}) registers only in development mode (--dangerously-load-development-channels)`,
				};
	}),
);
export type ChannelConfig = typeof ChannelConfig.Type;

/**
 * The launch dimensions the stand-up reads — the clean type every launcher child imports.
 *
 * `cliVersion` is an EXACT-optional key (`Schema.optionalKey`, issue #3417): absent ⇒ the field
 * is simply not present (`cliVersion?: CliVersion`), which IS the "unpinned" launch — a clean
 * representable variant, not a sentinel. `optionalKey` (not `optional`) so the only two states are
 * "absent = unpinned" and "present = a valid pin"; there is no third `undefined`-but-present state.
 */
export const LaunchConfig = Schema.Struct({
	cliVersion: Schema.optionalKey(CliVersion),
	engineCount: EngineCount,
	channels: ChannelConfig,
	/**
	 * The per-role model tiers (#3423), folded out of the role map into a flat lookup the bind
	 * constructor consumes by role. A role that omits `tier` is simply absent here — the launcher then
	 * emits no `--model` for it, preserving the CLI-default boot rather than guessing a tier.
	 */
	roleTiers: Schema.Record(Schema.String, Tier),
});
export type LaunchConfig = typeof LaunchConfig.Type;

/** A role entry's optional `tier` — the launch dimension #3423 promotes from ignored excess key. */
const RoleTierEntry = Schema.Struct({tier: Schema.optionalKey(Tier)});

/**
 * The one-role-map seam shape on disk (ADR 0189): a `roles` map keyed by the crew role slugs. The
 * launch reader takes the engine pool size at `roles["engineering-manager"].count` AND — as of
 * #3423 — each role's optional `tier` (its session's `--model`), no longer an ignored excess key.
 * The bridge entries are `optionalKey` (a role may omit its tier → no `--model`, the CLI default);
 * `engineering-manager` is required for its `count`, its `tier` optional. Remaining entry keys
 * (`wipCap`, the operator/notification blocks) stay ignored excess. `cliVersion` mirrors
 * `LaunchConfig`'s exact-optional shape (issue #3417): omit ⇒ unpinned.
 */
const RawLaunchConfig = Schema.Struct({
	cliVersion: Schema.optionalKey(CliVersion),
	roles: Schema.Struct({
		"chief-of-staff": Schema.optionalKey(RoleTierEntry),
		cartographer: Schema.optionalKey(RoleTierEntry),
		"intake-desk": Schema.optionalKey(RoleTierEntry),
		"engineering-manager": Schema.Struct({count: EngineCount, tier: Schema.optionalKey(Tier)}),
	}),
	channels: ChannelConfig,
});

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
 * The engine count is folded out of the role map — `roles["engineering-manager"].count` (ADR 0189)
 * — into the flat `engineCount` every launcher child consumes, so `LaunchConfig`'s shape is stable
 * across the seam move; a missing/blank/non-positive count fails closed naming that path. An
 * omitted `cliVersion` stays omitted through the fold (exact-optional, issue #3417) — the
 * "unpinned" launch — so the key is spread only when the operator supplied a pin.
 */
export const decodeLaunchConfig = (
	input: unknown,
	configPath: string,
): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	Schema.decodeUnknownEffect(RawLaunchConfig)(input).pipe(
		Effect.map((raw): LaunchConfig => {
			// Fold each role's decoded `tier` into the flat lookup, skipping a role that omitted one so
			// its absence stays absence — the bind then emits no `--model`, preserving the CLI default.
			const roleTiers: Record<string, Tier> = {};
			for (const role of CREW_ROLES) {
				const tier = raw.roles[role]?.tier;
				if (tier !== undefined) roleTiers[role] = tier;
			}
			return {
				...(raw.cliVersion !== undefined ? {cliVersion: raw.cliVersion} : {}),
				engineCount: raw.roles["engineering-manager"].count,
				channels: raw.channels,
				roleTiers,
			};
		}),
		Effect.mapError((error) => new LaunchConfigError({configPath, reason: error.message})),
	);

/**
 * Resolve → read → parse the crew config once, collapsing an unreadable path or malformed JSONC to
 * a single `LaunchConfigError`. Shared by both dimension readers so the resolve/read/parse contract
 * lives in one place; each reader decodes its own dimension off the parsed value.
 */
const readParsedConfig = (env: {
	readonly CREW_CONFIG?: string | undefined;
}): Effect.Effect<{readonly parsed: unknown; readonly configPath: string}, LaunchConfigError> =>
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
		return {parsed, configPath};
	});

/**
 * Resolve → read → parse → decode the crew config's launch dimensions. Every failure along the
 * way (path unreadable, JSONC malformed, a dimension missing/invalid) collapses to a single
 * `LaunchConfigError` carrying the resolved path and the reason — never a partial or a default.
 */
export const readLaunchConfig = (
	env: {readonly CREW_CONFIG?: string | undefined} = process.env,
): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	readParsedConfig(env).pipe(
		Effect.flatMap(({parsed, configPath}) => decodeLaunchConfig(parsed, configPath)),
	);
