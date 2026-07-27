/**
 * standup/channel-allowlist — the pre-launch probe of the CLI-side channel allowlist, the ONE gate
 * on the crew channel that no launcher-owned config can satisfy (issue #4297).
 *
 * `bind.ts` enforces the launcher's own `allowedChannelPlugins` and auto-allowlists the crew's own
 * plugin there, which is right — the launcher emits that ref, so it cannot be misconfigured. But the
 * Claude Code CLI enforces a SEPARATE, identically-named `allowedChannelPlugins` living in ORG MANAGED
 * SETTINGS (a different file, a different shape, a different enforcer), and when that one is unmet the
 * CLI's channel gate returns `{action: "skip", kind: "allowlist"}` — a SKIP, not an error. The session
 * launches, every launcher-side guard stays green, and the crew comes up with a dead channel. Nothing
 * on the launch path could observe that, so stand-up reported plain success on a silently dead crew.
 *
 * Grounded against the installed CLI bundle at 2.1.220, not intuited (CLAUDE.md's "ground falsifiable
 * runtime claims in source"). The gate's own code:
 *
 *     if(!o.dev){ let {entries:s,source:a} = getEffectiveChannelAllowlist(n?.allowedChannelPlugins);
 *       if(!s.some(l => l.plugin===o.name && l.marketplace===o.marketplace))
 *         return {action:"skip", kind:"allowlist", reason: a==="org" ? … : …} }
 *
 * Two facts follow, and they are the whole design: the check is bypassed entirely under
 * `--dangerously-load-development-channels` (the `!o.dev` guard), and when managed settings do NOT set
 * `allowedChannelPlugins` the effective list comes from a vendor-controlled remote-config ledger the
 * launcher has no way to read.
 *
 * The one non-obvious thing: this probe resolves THREE outcomes and refuses to collapse them, per
 * `claude-plugins/pipeline-crew/PROBES.md`. Only a policy surface the launcher actually READ and found
 * non-matching yields `blocked` (the sole outcome that may abort a launch). A surface it could not read
 * — absent, unparseable, an unenumerable drop-in directory, an existing MDM plist, or the Windows
 * registry it cannot interrogate at all — yields `unknown`, which never aborts but is never reported
 * as success either: the caller must say "unverified" out loud. That is the point of the issue, not a
 * detail of it — a skip that cannot be told apart from a success is the defect. The corollary that
 * keeps biting (#4223, #3715, #4290, and this module's own first round): a read that FAILS must never
 * be folded into the same value as a read that succeeded and found nothing.
 */
import os from "node:os";
import {Effect, FileSystem, Schema} from "effect";
import {CREW_CHANNEL_MARKETPLACE, CREW_CHANNEL_PLUGIN, CREW_PLUGIN_CHANNEL_REF} from "./bind.ts";
import type {ChannelConfig} from "./config.ts";

/** The managed-settings file name the CLI reads its org policy settings from, on every platform. */
export const MANAGED_SETTINGS_FILE = "managed-settings.json";
/** The drop-in directory sitting beside it, whose `*.json` files layer onto the same policy settings. */
export const MANAGED_SETTINGS_DROPIN_DIR = "managed-settings.d";

/**
 * The platform's managed-settings directory, verbatim from the installed CLI bundle's own resolver
 * (2.1.220: `switch(platform){case"macos":…;case"windows":…;default:"/etc/claude-code"}`). These are
 * OS-standard administrative locations, not operator data — nothing here varies per install.
 */
export const managedSettingsDir = (platform: NodeJS.Platform): string => {
	if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
	if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
	return "/etc/claude-code";
};

/** The macOS managed-preference domain the CLI loads its MDM settings from, and its parent dir. */
const MDM_PREFERENCE_DOMAIN = "com.anthropic.claudecode";
const MACOS_MANAGED_PREFERENCES_DIR = "/Library/Managed Preferences";

/**
 * The Windows policy registry keys the CLI merges into `policySettings`. Named as KEYS, not values —
 * this probe never reads them (see `PolicySurfaces.undeterminable`).
 */
export const WINDOWS_POLICY_REGISTRY_KEYS: readonly string[] = [
	"HKLM\\SOFTWARE\\Policies\\ClaudeCode",
	"HKCU\\SOFTWARE\\Policies\\ClaudeCode",
];

/**
 * The current login name, or `null` when the host has no resolvable passwd entry for it — the one
 * case `os.userInfo()` throws. `null` costs only the per-user plist from the opaque list, which is
 * safe: it can never turn an unread surface into a `blocked`, only into one fewer `unknown` trigger.
 */
const currentUsername = (): string | null => {
	// biome-ignore lint/plugin: pre-runtime bootstrap guard — this is the default parameter of a pure synchronous surface-name resolver, evaluated where no Effect runtime exists to carry an `E` channel.
	try {
		return os.userInfo().username || null;
	} catch {
		return null;
	}
};

/**
 * macOS managed-preference plists: present-checkable, unparseable-if-present (the `opaque` half of
 * `PolicySurfaces`). Both are listed, PER-USER FIRST, because that is the order the CLI builds them
 * in and it takes the first that exists and parses — so on a host carrying only a per-user plist,
 * a device-level-only guard would miss the very surface the CLI consulted.
 */
export const opaquePolicySurfaces = (
	platform: NodeJS.Platform,
	username: string | null = currentUsername(),
): readonly string[] => {
	if (platform !== "darwin") return [];
	const deviceLevel = `${MACOS_MANAGED_PREFERENCES_DIR}/${MDM_PREFERENCE_DOMAIN}.plist`;
	return username === null
		? [deviceLevel]
		: [`${MACOS_MANAGED_PREFERENCES_DIR}/${username}/${MDM_PREFERENCE_DOMAIN}.plist`, deviceLevel];
};

/**
 * Policy surfaces whose PRESENCE this probe cannot even test — the Windows registry, which is not a
 * filesystem path at all. `fs.exists` on a registry key would answer "absent" for a key that is in
 * fact set, which is precisely the unread-surface-yields-a-definite-answer defect this module exists
 * to avoid, so one of these in scope resolves `unknown` outright rather than being existence-probed.
 */
export const undeterminablePolicySurfaces = (platform: NodeJS.Platform): readonly string[] =>
	platform === "win32" ? WINDOWS_POLICY_REGISTRY_KEYS : [];

/**
 * Where a probe run looks. Three kinds, and the split IS the AC: `settingsFile`/`dropInDir` are read
 * and parsed; `opaque` surfaces are existence-checked but not parsed; `undeterminable` surfaces
 * cannot be interrogated at all. Anything but the first kind forces `unknown`, never `blocked`.
 */
export interface PolicySurfaces {
	readonly settingsFile: string;
	readonly dropInDir: string;
	readonly opaque: readonly string[];
	readonly undeterminable: readonly string[];
}

/** The default surfaces for a platform — the production wiring, and the shape tests substitute. */
export const policySurfacesFor = (platform: NodeJS.Platform): PolicySurfaces => {
	const dir = managedSettingsDir(platform);
	const sep = platform === "win32" ? "\\" : "/";
	return {
		settingsFile: `${dir}${sep}${MANAGED_SETTINGS_FILE}`,
		dropInDir: `${dir}${sep}${MANAGED_SETTINGS_DROPIN_DIR}`,
		opaque: opaquePolicySurfaces(platform),
		undeterminable: undeterminablePolicySurfaces(platform),
	};
};

/**
 * What the probe concluded about whether the crew channel will actually bind:
 *
 * - `allowed` — a policy surface was READ and lists this plugin. The channel will bind.
 * - `blocked` — a policy surface was READ, sets `allowedChannelPlugins`, and this plugin is not in it.
 *   The channel will NOT bind. The only outcome that aborts a launch.
 * - `unknown` — the probe could not determine it. Never a launch abort, never reportable as success.
 * - `not-applicable` — development mode bypasses the CLI's allowlist gate outright, so there is
 *   nothing to ask. Distinct from `allowed`: nothing was verified, but nothing needed to be.
 */
export type ChannelAllowlistStatus = "allowed" | "blocked" | "unknown" | "not-applicable";

export interface ChannelAllowlistOutcome {
	readonly status: ChannelAllowlistStatus;
	/** The `plugin:<name>@<marketplace>` channel ref this verdict is about. */
	readonly ref: string;
	/** Operator-facing prose: what was concluded and why, in the probe's own words. */
	readonly reason: string;
	/** Every policy surface the probe consulted — so "what did it look at" is answerable from the log. */
	readonly consulted: readonly string[];
}

/**
 * The managed-settings entry an operator adds to make the crew channel bind. Named as a KEY + shape,
 * never a filled-in example carrying anyone's real data.
 */
export const MANAGED_SETTINGS_REMEDY = `add an "allowedChannelPlugins" entry {"marketplace": "${CREW_CHANNEL_MARKETPLACE}", "plugin": "${CREW_CHANNEL_PLUGIN}"} to the org's managed settings (${MANAGED_SETTINGS_FILE}), or run the crew in development channel mode`;

/**
 * The crew channel is proven not to bind: an org policy surface the launcher READ sets
 * `allowedChannelPlugins` and the crew plugin is not on it, so the CLI would skip the channel and the
 * crew would come up dead. Refuse the launch — this is the "inert channel" abort
 * `claude-plugins/pipeline-crew/commands/stand-up.md` already promises.
 */
export class ChannelAllowlistBlockedError extends Schema.TaggedErrorClass<ChannelAllowlistBlockedError>()(
	"@kampus/pipeline-crew-mcp/standup/ChannelAllowlistBlockedError",
	{
		ref: Schema.String,
		reason: Schema.String,
		remedy: Schema.String,
		consulted: Schema.Array(Schema.String),
	},
) {}

/** One `allowedChannelPlugins` entry as the CLI's own settings schema declares it: `{marketplace, plugin}`. */
interface AllowlistEntry {
	readonly marketplace: string;
	readonly plugin: string;
}

/**
 * Read `allowedChannelPlugins` out of one parsed policy-settings object. Three results, kept distinct
 * for the same reason the outcome is: the key absent (the CLI then falls back to the vendor ledger),
 * a well-formed list, and a list whose shape this probe does not recognize — which is a read it cannot
 * trust, not an empty list.
 */
type ExtractedAllowlist =
	| {readonly kind: "absent"}
	| {readonly kind: "entries"; readonly entries: readonly AllowlistEntry[]}
	| {readonly kind: "malformed"};

const extractAllowlist = (settings: unknown): ExtractedAllowlist => {
	if (typeof settings !== "object" || settings === null) return {kind: "malformed"};
	const raw = (settings as Record<string, unknown>).allowedChannelPlugins;
	if (raw === undefined || raw === null) return {kind: "absent"};
	if (!Array.isArray(raw)) return {kind: "malformed"};
	const entries: AllowlistEntry[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return {kind: "malformed"};
		const {marketplace, plugin} = item as Record<string, unknown>;
		if (typeof marketplace !== "string" || typeof plugin !== "string") return {kind: "malformed"};
		entries.push({marketplace, plugin});
	}
	return {kind: "entries", entries};
};

/** A JSON policy source the probe managed to read, or the reason it could not. */
type SourceRead =
	| {readonly kind: "read"; readonly path: string; readonly settings: unknown}
	| {readonly kind: "absent"; readonly path: string}
	| {readonly kind: "unreadable"; readonly path: string; readonly detail: string};

/** Parse one source's text, folding a parse failure into the `unreadable` variant rather than a throw. */
const parseSettings = (path: string, text: string): Effect.Effect<SourceRead> =>
	Effect.try({
		try: (): SourceRead => ({kind: "read", path, settings: JSON.parse(text)}),
		catch: (cause): SourceRead => ({
			kind: "unreadable",
			path,
			detail: `not valid JSON: ${String(cause)}`,
		}),
	}).pipe(Effect.catch(Effect.succeed));

const readJsonSource = (fs: FileSystem.FileSystem, path: string): Effect.Effect<SourceRead> =>
	fs.readFileString(path).pipe(
		Effect.flatMap((text) => parseSettings(path, text)),
		Effect.catch((cause) =>
			fs.exists(path).pipe(
				Effect.map(
					(present): SourceRead =>
						present ? {kind: "unreadable", path, detail: String(cause)} : {kind: "absent", path},
				),
				// The existence probe itself faulting is the PROBES.md "could not ask" case: an unreadable
				// surface, never an absent one — collapsing it to absent is what would fabricate a verdict.
				Effect.orElseSucceed((): SourceRead => ({kind: "unreadable", path, detail: String(cause)})),
			),
		),
	);

/**
 * The drop-in dir's `*.json` files, or why they could not be listed. Same three-way shape (and same
 * reason for it) as `SourceRead`: an unreadable DIRECTORY is not an absent one either. `readDirectory`
 * fails identically on `ENOENT` and `EACCES`/`ENOTDIR`, so without the `fs.exists` disambiguation a
 * root-only drop-in dir beside a world-readable settings file yields `blocked` off a partial read.
 */
type DropInRead =
	| {readonly kind: "files"; readonly paths: readonly string[]}
	| {readonly kind: "absent"}
	| {readonly kind: "unreadable"; readonly detail: string};

const readDropInDir = (fs: FileSystem.FileSystem, dir: string): Effect.Effect<DropInRead> =>
	fs.readDirectory(dir).pipe(
		Effect.map(
			(names): DropInRead => ({
				kind: "files",
				paths: names
					.filter((name) => name.endsWith(".json"))
					.sort()
					.map((name) => `${dir}/${name}`),
			}),
		),
		Effect.catch((cause) =>
			fs.exists(dir).pipe(
				Effect.map(
					(present): DropInRead =>
						present ? {kind: "unreadable", detail: String(cause)} : {kind: "absent"},
				),
				Effect.orElseSucceed((): DropInRead => ({kind: "unreadable", detail: String(cause)})),
			),
		),
	);

export interface ChannelAllowlistProbeInput {
	readonly plugin: string;
	readonly marketplace: string;
	readonly ref: string;
	readonly surfaces: PolicySurfaces;
}

/**
 * Probe whether the CLI's effective channel allowlist admits the crew plugin. Never fails — every
 * fault folds into `unknown`, because a probe that could not run carries no information about the
 * target (PROBES.md's outcome 3, applied to a config surface instead of a liveness endpoint).
 */
export const probeChannelAllowlist = (
	input: ChannelAllowlistProbeInput,
): Effect.Effect<ChannelAllowlistOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const {plugin, marketplace, ref, surfaces} = input;
		const consulted: string[] = [];

		const undeterminable = surfaces.undeterminable[0];
		if (undeterminable !== undefined) {
			consulted.push(...surfaces.undeterminable);
			return {
				status: "unknown",
				ref,
				consulted,
				reason: `a policy surface this probe cannot interrogate at all (${undeterminable}) is in scope on this platform, so the CLI's effective channel allowlist cannot be resolved from here`,
			};
		}

		for (const path of surfaces.opaque) {
			consulted.push(path);
			const present = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true));
			if (present) {
				return {
					status: "unknown",
					ref,
					consulted,
					reason: `an MDM-managed policy surface (${path}) is present and the launcher cannot parse it, so the CLI's effective channel allowlist cannot be resolved from here`,
				};
			}
		}

		consulted.push(surfaces.dropInDir);
		const dropIn = yield* readDropInDir(fs, surfaces.dropInDir);
		if (dropIn.kind === "unreadable") {
			return {
				status: "unknown",
				ref,
				consulted,
				reason: `the managed-settings drop-in directory (${surfaces.dropInDir}) is present but could not be enumerated: ${dropIn.detail} — a drop-in file it holds could carry the entry, so no verdict can be drawn from the sources that did read`,
			};
		}
		const dropInFiles = dropIn.kind === "files" ? dropIn.paths : [];

		const reads: SourceRead[] = [];
		for (const path of [surfaces.settingsFile, ...dropInFiles]) {
			consulted.push(path);
			reads.push(yield* readJsonSource(fs, path));
		}

		const unreadable = reads.find((read) => read.kind === "unreadable");
		if (unreadable !== undefined && unreadable.kind === "unreadable") {
			return {
				status: "unknown",
				ref,
				consulted,
				reason: `a managed-settings source (${unreadable.path}) exists but could not be read: ${unreadable.detail}`,
			};
		}

		// A later source that lists the plugin wins over an earlier one that does not: the CLI layers its
		// policy sources, so "some readable source admits it" is the only claim this probe can soundly make.
		let sawAllowlist = false;
		for (const read of reads) {
			if (read.kind !== "read") continue;
			const extracted = extractAllowlist(read.settings);
			if (extracted.kind === "malformed") {
				return {
					status: "unknown",
					ref,
					consulted,
					reason: `a managed-settings source (${read.path}) sets "allowedChannelPlugins" in a shape this probe does not recognize (expected an array of {"marketplace","plugin"} objects), so its effective entries cannot be resolved`,
				};
			}
			if (extracted.kind === "absent") continue;
			sawAllowlist = true;
			if (extracted.entries.some((e) => e.plugin === plugin && e.marketplace === marketplace)) {
				return {
					status: "allowed",
					ref,
					consulted,
					reason: `org managed settings list ${plugin}@${marketplace} in "allowedChannelPlugins" (${read.path})`,
				};
			}
		}

		if (sawAllowlist) {
			return {
				status: "blocked",
				ref,
				consulted,
				reason: `org managed settings set "allowedChannelPlugins" and ${plugin}@${marketplace} is not on it — the CLI would skip this channel ({action:"skip", kind:"allowlist"}) and the crew would come up with a dead channel`,
			};
		}

		return {
			status: "unknown",
			ref,
			consulted,
			reason: `no managed-settings source sets "allowedChannelPlugins", so the CLI resolves its effective allowlist from the vendor-controlled channel ledger — a remote-config value the launcher cannot read. A self-published plugin is not expected to be on that ledger, so the channel may well come up dead`,
		};
	});

/** The probe as the orchestration injects it — substituted wholesale in tests, no filesystem needed. */
export type ChannelAllowlistProbe = Effect.Effect<
	ChannelAllowlistOutcome,
	never,
	FileSystem.FileSystem
>;

/** The production probe: the crew's own channel ref against this platform's policy surfaces. */
export const productionChannelAllowlistProbe: ChannelAllowlistProbe = Effect.suspend(() =>
	probeChannelAllowlist({
		plugin: CREW_CHANNEL_PLUGIN,
		marketplace: CREW_CHANNEL_MARKETPLACE,
		ref: CREW_PLUGIN_CHANNEL_REF,
		surfaces: policySurfacesFor(process.platform),
	}),
);

/**
 * Assert the crew channel will bind, before any session launches. Returns the outcome for the caller
 * to REPORT (an `unknown` must reach the operator verbatim — that is the whole fix), and fails only on
 * `blocked`, the one verdict backed by a surface the probe actually read.
 *
 * Development mode short-circuits to `not-applicable` without touching the filesystem: the CLI's
 * allowlist check sits behind its own `!dev` guard, so under
 * `--dangerously-load-development-channels` there is no gate to clear.
 */
export const assertChannelAllowlist = (
	channels: Pick<ChannelConfig, "mode">,
	probe: ChannelAllowlistProbe = productionChannelAllowlistProbe,
): Effect.Effect<ChannelAllowlistOutcome, ChannelAllowlistBlockedError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (channels.mode !== "allowlist") {
			return {
				status: "not-applicable",
				ref: CREW_PLUGIN_CHANNEL_REF,
				consulted: [],
				reason:
					"development channel mode bypasses the CLI's plugin allowlist gate, so there is nothing to verify",
			} satisfies ChannelAllowlistOutcome;
		}
		const outcome = yield* probe;
		if (outcome.status === "blocked") {
			return yield* new ChannelAllowlistBlockedError({
				ref: outcome.ref,
				reason: outcome.reason,
				remedy: MANAGED_SETTINGS_REMEDY,
				consulted: outcome.consulted,
			});
		}
		return outcome;
	});

/**
 * Render an outcome as the operator-facing line stand-up prints. `unknown` is deliberately as loud as
 * an abort and never blends into the success summary — an unverified channel is not a verified one.
 */
export const renderChannelAllowlistOutcome = (outcome: ChannelAllowlistOutcome): string => {
	const consulted =
		outcome.consulted.length > 0 ? ` [consulted: ${outcome.consulted.join(", ")}]` : "";
	if (outcome.status === "allowed") {
		return `channel allowlist VERIFIED for ${outcome.ref} — ${outcome.reason}${consulted}`;
	}
	if (outcome.status === "not-applicable") {
		return `channel allowlist NOT APPLICABLE for ${outcome.ref} — ${outcome.reason}`;
	}
	return [
		`channel allowlist UNVERIFIED (unknown) for ${outcome.ref} — ${outcome.reason}${consulted}.`,
		`This is NOT a confirmation that the channel works: the crew may come up with a dead channel (no channel_send, no tracker traffic, no error anywhere).`,
		`To make it verifiable: ${MANAGED_SETTINGS_REMEDY}.`,
	].join("\n  ");
};
