/**
 * standup/channel-allowlist — the pre-launch probe of the CLI-side org-managed channel allowlist
 * (issue #4297). These tests pin the property the fix exists for: the probe resolves THREE outcomes
 * and never collapses them, so "the channel is verified working" and "we could not check the channel"
 * are distinguishable states. Only a policy surface actually READ and found non-matching yields
 * `blocked` (the sole launch-aborting verdict); an absent, unreadable, malformed, or MDM-opaque
 * surface yields `unknown`, which proceeds and must be reported. The whole filesystem is substituted
 * via `FileSystem.layerNoop`, so no real managed-settings file is touched.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Layer} from "effect";
import {CREW_CHANNEL_MARKETPLACE, CREW_CHANNEL_PLUGIN, CREW_PLUGIN_CHANNEL_REF} from "./bind.ts";
import {
	assertChannelAllowlist,
	ChannelAllowlistBlockedError,
	type ChannelAllowlistOutcome,
	managedSettingsDir,
	opaquePolicySurfaces,
	type PolicySurfaces,
	policySurfacesFor,
	probeChannelAllowlist,
	renderChannelAllowlistOutcome,
} from "./channel-allowlist.ts";

const SURFACES: PolicySurfaces = {
	settingsFile: "/policy/managed-settings.json",
	dropInDir: "/policy/managed-settings.d",
	opaque: [],
	undeterminable: [],
};

/** A whole filesystem backed by one in-memory path→content map; anything unlisted is absent. */
const fakeFs = (
	files: Readonly<Record<string, string>>,
	opts: {readonly opaquePresent?: readonly string[]; readonly unreadable?: readonly string[]} = {},
) => {
	const unreadable = new Set(opts.unreadable ?? []);
	// An unreadable path is PRESENT — that is the whole distinction under test: a surface that exists
	// but cannot be read must not be classified the same as one that is simply absent.
	const present = new Set([...Object.keys(files), ...unreadable, ...(opts.opaquePresent ?? [])]);
	return FileSystem.layerNoop({
		exists: (path) => Effect.succeed(present.has(String(path))),
		readFileString: (path) => {
			const key = String(path);
			if (unreadable.has(key)) return Effect.fail(new Error("EACCES") as never);
			const content = files[key];
			return content === undefined
				? Effect.fail(new Error("ENOENT") as never)
				: Effect.succeed(content);
		},
		readDirectory: (path) => {
			const key = String(path);
			// A directory in `unreadable` EXISTS but cannot be enumerated (EACCES) — distinct from one
			// that is simply absent, which is the distinction the drop-in read has to preserve.
			if (unreadable.has(key)) return Effect.fail(new Error("EACCES") as never);
			const prefix = `${key}/`;
			const names = Object.keys(files)
				.filter((f) => f.startsWith(prefix))
				.map((f) => f.slice(prefix.length));
			const opaqueNames = [...unreadable]
				.filter((f) => f.startsWith(prefix))
				.map((f) => f.slice(prefix.length));
			return Effect.succeed([...names, ...opaqueNames]);
		},
	});
};

const probe = (
	files: Readonly<Record<string, string>>,
	opts: Parameters<typeof fakeFs>[1] = {},
	surfaces: PolicySurfaces = SURFACES,
): Effect.Effect<ChannelAllowlistOutcome> =>
	probeChannelAllowlist({
		plugin: CREW_CHANNEL_PLUGIN,
		marketplace: CREW_CHANNEL_MARKETPLACE,
		ref: CREW_PLUGIN_CHANNEL_REF,
		surfaces,
	}).pipe(Effect.provide(Layer.mergeAll(fakeFs(files, opts))));

const settingsListing = (entries: readonly {marketplace: string; plugin: string}[]): string =>
	JSON.stringify({allowedChannelPlugins: entries});

describe("standup/channel-allowlist — policy surface resolution", () => {
	it("resolves each platform's managed-settings directory verbatim from the CLI's own resolver", () => {
		assert.strictEqual(managedSettingsDir("darwin"), "/Library/Application Support/ClaudeCode");
		assert.strictEqual(managedSettingsDir("win32"), "C:\\Program Files\\ClaudeCode");
		assert.strictEqual(managedSettingsDir("linux"), "/etc/claude-code");
	});

	it("names the managed-settings file and its drop-in dir under that directory", () => {
		const surfaces = policySurfacesFor("linux");
		assert.strictEqual(surfaces.settingsFile, "/etc/claude-code/managed-settings.json");
		assert.strictEqual(surfaces.dropInDir, "/etc/claude-code/managed-settings.d");
	});

	it("lists BOTH macOS MDM plists, per-user first — the order the CLI resolves them in", () => {
		// The CLI builds per-user then device-level and takes the first that exists and parses, so a
		// device-level-only guard misses the surface it actually consulted on a per-user managed host.
		assert.deepStrictEqual(opaquePolicySurfaces("darwin", "someone"), [
			"/Library/Managed Preferences/someone/com.anthropic.claudecode.plist",
			"/Library/Managed Preferences/com.anthropic.claudecode.plist",
		]);
		assert.deepStrictEqual(opaquePolicySurfaces("darwin", null), [
			"/Library/Managed Preferences/com.anthropic.claudecode.plist",
		]);
		assert.deepStrictEqual(opaquePolicySurfaces("linux"), []);
	});

	it("names the Windows registry keys as UNDETERMINABLE, not as existence-checkable paths", () => {
		// A registry key is not a filesystem path: `fs.exists` on one answers "absent" for a key that
		// is in fact set. Claiming coverage the code did not have was the docblock's overclaim.
		assert.deepStrictEqual(policySurfacesFor("win32").opaque, []);
		assert.isAbove(policySurfacesFor("win32").undeterminable.length, 0);
		assert.deepStrictEqual(policySurfacesFor("linux").undeterminable, []);
	});
});

describe("standup/channel-allowlist — probeChannelAllowlist", () => {
	it.effect("ALLOWED when a readable policy surface lists the crew plugin", () =>
		Effect.gen(function* () {
			const outcome = yield* probe({
				[SURFACES.settingsFile]: settingsListing([
					{marketplace: CREW_CHANNEL_MARKETPLACE, plugin: CREW_CHANNEL_PLUGIN},
				]),
			});
			assert.strictEqual(outcome.status, "allowed");
			assert.include(outcome.consulted, SURFACES.settingsFile);
		}),
	);

	it.effect("ALLOWED when a drop-in file lists it even though the base file does not", () =>
		Effect.gen(function* () {
			const outcome = yield* probe({
				[SURFACES.settingsFile]: settingsListing([{marketplace: "other", plugin: "other"}]),
				[`${SURFACES.dropInDir}/10-channels.json`]: settingsListing([
					{marketplace: CREW_CHANNEL_MARKETPLACE, plugin: CREW_CHANNEL_PLUGIN},
				]),
			});
			assert.strictEqual(outcome.status, "allowed");
		}),
	);

	it.effect("BLOCKED when a readable surface sets the list and the crew plugin is not on it", () =>
		Effect.gen(function* () {
			const outcome = yield* probe({
				[SURFACES.settingsFile]: settingsListing([{marketplace: "acme", plugin: "acme-chat"}]),
			});
			assert.strictEqual(outcome.status, "blocked");
			assert.include(outcome.reason, "dead channel");
		}),
	);

	it.effect("BLOCKED on a same-name/different-marketplace entry — both fields must match", () =>
		Effect.gen(function* () {
			// The CLI matches `plugin === name && marketplace === marketplace`; a name-only match is not a match.
			const outcome = yield* probe({
				[SURFACES.settingsFile]: settingsListing([
					{marketplace: "someone-elses-marketplace", plugin: CREW_CHANNEL_PLUGIN},
				]),
			});
			assert.strictEqual(outcome.status, "blocked");
		}),
	);

	it.effect(
		"UNKNOWN when no managed-settings source exists at all (the vendor-ledger fallback)",
		() =>
			Effect.gen(function* () {
				const outcome = yield* probe({});
				assert.strictEqual(outcome.status, "unknown");
				assert.include(outcome.reason, "ledger");
			}),
	);

	it.effect("UNKNOWN when a source sets no allowedChannelPlugins key", () =>
		Effect.gen(function* () {
			const outcome = yield* probe({
				[SURFACES.settingsFile]: JSON.stringify({channelsEnabled: true}),
			});
			assert.strictEqual(outcome.status, "unknown");
		}),
	);

	it.effect("UNKNOWN — never blocked — when a present source cannot be read", () =>
		Effect.gen(function* () {
			// The PROBES.md distinction the whole module turns on: "I could not ask" is not "the answer is no".
			const outcome = yield* probe({}, {unreadable: [SURFACES.settingsFile]});
			assert.strictEqual(outcome.status, "unknown");
			assert.include(outcome.reason, SURFACES.settingsFile);
		}),
	);

	it.effect("UNKNOWN when a present source is not valid JSON", () =>
		Effect.gen(function* () {
			const outcome = yield* probe({[SURFACES.settingsFile]: "{ not json"});
			assert.strictEqual(outcome.status, "unknown");
		}),
	);

	it.effect("UNKNOWN when allowedChannelPlugins is set in an unrecognized shape", () =>
		Effect.gen(function* () {
			// A bare string list is the CLI's OTHER identically-named field (the launcher's own). Reading it
			// as an empty effective allowlist would manufacture a `blocked` verdict out of a shape mismatch.
			const outcome = yield* probe({
				[SURFACES.settingsFile]: JSON.stringify({allowedChannelPlugins: [CREW_CHANNEL_PLUGIN]}),
			});
			assert.strictEqual(outcome.status, "unknown");
		}),
	);

	it.effect(
		"UNKNOWN — never blocked — when the drop-in directory exists but cannot be enumerated",
		() =>
			Effect.gen(function* () {
				// The regression this test exists for: a root-only drop-in dir beside a world-readable
				// settings file that sets the list without the crew plugin. Collapsing the failed
				// enumeration to "no drop-in files" turns an unread surface into a launch-aborting
				// `blocked` — a definite answer drawn from a partial read.
				const outcome = yield* probe(
					{[SURFACES.settingsFile]: settingsListing([{marketplace: "acme", plugin: "acme-chat"}])},
					{unreadable: [SURFACES.dropInDir]},
				);
				assert.strictEqual(outcome.status, "unknown");
				assert.include(outcome.reason, SURFACES.dropInDir);
			}),
	);

	it.effect("consults the drop-in directory by name even when it is simply absent", () =>
		Effect.gen(function* () {
			// An absent dir still resolves normally — but the operator log must show it was attempted,
			// otherwise "what did the probe look at" is unanswerable for the surface most likely to
			// hold the missing entry.
			const outcome = yield* probe({
				[SURFACES.settingsFile]: settingsListing([{marketplace: "acme", plugin: "acme-chat"}]),
			});
			assert.strictEqual(outcome.status, "blocked");
			assert.include(outcome.consulted, SURFACES.dropInDir);
		}),
	);

	it.effect("UNKNOWN — never blocked — when an undeterminable policy surface is in scope", () =>
		Effect.gen(function* () {
			const withRegistry: PolicySurfaces = {
				...SURFACES,
				undeterminable: ["HKLM\\SOFTWARE\\Policies\\ClaudeCode"],
			};
			const outcome = yield* probe(
				{[SURFACES.settingsFile]: settingsListing([{marketplace: "acme", plugin: "acme-chat"}])},
				{},
				withRegistry,
			);
			assert.strictEqual(outcome.status, "unknown");
			assert.include(outcome.consulted, "HKLM\\SOFTWARE\\Policies\\ClaudeCode");
		}),
	);

	it.effect("UNKNOWN — never blocked — when an opaque MDM policy surface is present", () =>
		Effect.gen(function* () {
			const withMdm: PolicySurfaces = {...SURFACES, opaque: ["/policy/mdm.plist"]};
			const outcome = yield* probe(
				{[SURFACES.settingsFile]: settingsListing([{marketplace: "acme", plugin: "acme-chat"}])},
				{opaquePresent: ["/policy/mdm.plist"]},
				withMdm,
			);
			assert.strictEqual(outcome.status, "unknown");
		}),
	);
});

describe("standup/channel-allowlist — assertChannelAllowlist", () => {
	// The assert declares a `FileSystem` requirement for its production probe; each injected probe here
	// already carries its own fake filesystem, so an empty one discharges the leftover declared context.
	const assertWith = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
		effect.pipe(Effect.provide(fakeFs({})));

	it.effect("aborts on BLOCKED, naming the ref and the managed-settings remedy", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				assertWith(
					assertChannelAllowlist(
						{mode: "allowlist"},
						probe({
							[SURFACES.settingsFile]: settingsListing([
								{marketplace: "acme", plugin: "acme-chat"},
							]),
						}),
					),
				),
			);
			assert.instanceOf(error, ChannelAllowlistBlockedError);
			assert.strictEqual(error.ref, CREW_PLUGIN_CHANNEL_REF);
			assert.include(error.remedy, "allowedChannelPlugins");
			assert.include(error.remedy, CREW_CHANNEL_PLUGIN);
		}),
	);

	it.effect("returns UNKNOWN rather than aborting — an unrunnable check never gates", () =>
		Effect.gen(function* () {
			const outcome = yield* assertWith(assertChannelAllowlist({mode: "allowlist"}, probe({})));
			assert.strictEqual(outcome.status, "unknown");
		}),
	);

	it.effect("short-circuits development mode to NOT APPLICABLE without probing", () =>
		Effect.gen(function* () {
			const probeNeverRuns = Effect.die("the probe must not run in development mode");
			const outcome = yield* assertWith(
				assertChannelAllowlist({mode: "development"}, probeNeverRuns),
			);
			assert.strictEqual(outcome.status, "not-applicable");
		}),
	);
});

describe("standup/channel-allowlist — renderChannelAllowlistOutcome", () => {
	const outcomeAt = (status: ChannelAllowlistOutcome["status"]): ChannelAllowlistOutcome => ({
		status,
		ref: CREW_PLUGIN_CHANNEL_REF,
		reason: "because",
		consulted: [SURFACES.settingsFile],
	});

	it("renders a verified channel as VERIFIED", () => {
		assert.include(renderChannelAllowlistOutcome(outcomeAt("allowed")), "VERIFIED");
	});

	it("renders an unresolvable channel as UNVERIFIED, and says it is not a confirmation", () => {
		// The load-bearing assertion of the whole issue: the unknown line must not read as a success.
		const rendered = renderChannelAllowlistOutcome(outcomeAt("unknown"));
		assert.include(rendered, "UNVERIFIED");
		assert.include(rendered, "NOT a confirmation");
		assert.include(rendered, "allowedChannelPlugins");
		assert.notInclude(renderChannelAllowlistOutcome(outcomeAt("allowed")), "UNVERIFIED");
	});

	it("renders development mode as NOT APPLICABLE, distinct from VERIFIED", () => {
		const rendered = renderChannelAllowlistOutcome(outcomeAt("not-applicable"));
		assert.include(rendered, "NOT APPLICABLE");
		assert.notInclude(rendered, "VERIFIED");
	});
});
