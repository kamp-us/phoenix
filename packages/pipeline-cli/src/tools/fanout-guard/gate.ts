/**
 * The `fanout-guard` filesystem gate (ADR 0155) — the IO seam behind the
 * fanned-mutation publish check, split from `command.ts` so it is crossable in unit
 * tests over a fake repo dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom; #855).
 *
 * `checkFanout` is the CI gate: it enumerates each feature's `mutations.ts`,
 * parses each for its `Fate.mutation` keys and whether it references a
 * `WorkerLivePublisher` publish, parses the fanned-mutation manifest, and delegates the
 * verdict to the pure core (`fanout-guard.ts`). It fails `CheckFailed` (exit non-zero)
 * on drift (an unclassified/stale mutation), a fanned mutation whose feature omits the
 * publish, or zero mutations in scope (fail-closed, ADR 0092). A directory/file IO
 * failure is an `IoError` (also non-zero — both failures, undistinguished, per the
 * bin's contract).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	type DiscoveredMutation,
	type FeaturePublishes,
	type FeatureTargets,
	judge,
	type ManifestEntry,
	parseFeatureDelegations,
	parseFeatureTargets,
	parseLiveTopicMap,
	parseManifestEntries,
	parseMutationKeys,
	referencesPublisher,
	renderReport,
	resolveReachableTargets,
} from "./fanout-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

// Repo-relative path fragments (POSIX): combined with the absolute `root` at runtime
// through the `Path.Path` seam, so they stay plain-string literals (the catalog-guard
// idiom) rather than a module-level `node:path` join with no seam in scope.
const FEATURES_DIR = "apps/web/worker/features";
const MUTATIONS_FILE = "mutations.ts";
const LIVE_FILE = "live.ts";
const MANIFEST_PATH = `${FEATURES_DIR}/fate-live/fanned-mutations.ts`;
const PROTOCOL_PATH = `${FEATURES_DIR}/fate-live/protocol.ts`;

/** The gathered facts across all feature mutation + live files. */
interface GatheredFeatures {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly featurePublishes: FeaturePublishes;
	readonly featureTargets: FeatureTargets;
}

/**
 * Enumerate `<root>/apps/web/worker/features/*` and, for each that holds a
 * `mutations.ts`, parse its `Fate.mutation` keys and whether it references a publish;
 * for each that holds a `live.ts`, gather the `/fate/live` targets it reaches (topics +
 * one-hop delegation, resolved via the `LiveTopic` map). `live.ts` is scanned even for a
 * feature with no `mutations.ts`, so a delegated-through binding (report → pano/sözlük)
 * contributes its targets to the closure.
 *
 * All directory/file IO goes through the Effect `FileSystem`/`Path` seam (over the bin's
 * `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for the real
 * disk (.patterns/effect-platform-access.md); a fs fault folds `PlatformError` → the
 * `IoError` this gate already carries. This is the one why-note for the file's
 * platform-seam migration — the other IO helpers below follow the same shape.
 */
const gatherFeatures = (
	root: string,
	liveTopicMap: ReadonlyMap<string, string>,
): Effect.Effect<GatheredFeatures, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const base = path.join(root, FEATURES_DIR);
		const entries = yield* fs.readDirectory(base);
		const discovered: Array<DiscoveredMutation> = [];
		const featurePublishes = new Map<string, boolean>();
		const directTargets = new Map<string, ReadonlySet<string>>();
		const delegations = new Map<string, ReadonlySet<string>>();
		for (const name of entries) {
			const abs = path.join(base, name);
			if ((yield* fs.stat(abs)).type !== "Directory") continue;
			const mutationsPath = path.join(abs, MUTATIONS_FILE);
			if (yield* fs.exists(mutationsPath)) {
				const source = yield* fs.readFileString(mutationsPath, "utf8");
				for (const key of parseMutationKeys(source)) {
					discovered.push({key, feature: name});
				}
				featurePublishes.set(name, referencesPublisher(source));
			}
			const livePath = path.join(abs, LIVE_FILE);
			if (yield* fs.exists(livePath)) {
				const liveSource = yield* fs.readFileString(livePath, "utf8");
				directTargets.set(name, parseFeatureTargets(liveSource, liveTopicMap));
				delegations.set(name, parseFeatureDelegations(liveSource));
			}
		}
		return {
			discovered,
			featurePublishes,
			featureTargets: resolveReachableTargets(directTargets, delegations),
		};
	}).pipe(Effect.mapError((cause) => new IoError({path: `${root}/${FEATURES_DIR}`, cause})));

/**
 * Read + parse the `LiveTopic` map from `fate-live/protocol.ts` — the source of truth
 * mapping a `LiveTopic.<prop>` reference (as a `live.ts` binding uses it) to its wire
 * value (as the manifest declares it). A missing protocol file yields an empty map; the
 * topic check then reports every declared connection topic as unreachable, which
 * fail-closes loudly (a moved protocol file is a real misconfiguration).
 */
const readLiveTopicMap = (
	root: string,
): Effect.Effect<ReadonlyMap<string, string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const protocolPath = path.join(root, PROTOCOL_PATH);
		if (!(yield* fs.exists(protocolPath))) return new Map<string, string>();
		return parseLiveTopicMap(yield* fs.readFileString(protocolPath, "utf8"));
	}).pipe(Effect.mapError((cause) => new IoError({path: `${root}/${PROTOCOL_PATH}`, cause})));

/** Read + parse the fanned-mutation manifest; a missing manifest fails closed. */
const readManifest = (
	root: string,
): Effect.Effect<
	ReadonlyArray<ManifestEntry>,
	IoError | CheckFailed,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const manifestPath = path.join(root, MANIFEST_PATH);
		const text = yield* fs
			.readFileString(manifestPath, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: manifestPath, cause})));
		const entries = parseManifestEntries(text);
		if (entries.length === 0) {
			// A present-but-empty (or unparseable) manifest is a broken scope assumption,
			// not a vacuous pass — fail closed (ADR 0092).
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						`fanout-guard: parsed ZERO rows from ${MANIFEST_PATH} — the manifest is empty or its ` +
						"row shape changed, so the classification is broken. Fail-closed (ADR 0092/0155).",
				}),
			);
		}
		return entries;
	});

/**
 * The CI gate: succeed when every worker mutation is classified, every fanned mutation's
 * feature publishes a `/fate/live` invalidation, and each publish aims at its declared
 * topic, else `CheckFailed`. Fails closed on zero mutations in scope (ADR 0092).
 */
export const checkFanout = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const manifest = yield* readManifest(root);
		const liveTopicMap = yield* readLiveTopicMap(root);
		const {discovered, featurePublishes, featureTargets} = yield* gatherFeatures(
			root,
			liveTopicMap,
		);
		const verdict = judge({discovered, manifest, featurePublishes, featureTargets});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
