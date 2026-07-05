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
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {
	type DiscoveredMutation,
	type FeaturePublishes,
	judge,
	type ManifestEntry,
	parseManifestEntries,
	parseMutationKeys,
	referencesPublisher,
	renderReport,
} from "./fanout-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const FEATURES_DIR = join("apps", "web", "worker", "features");
const MUTATIONS_FILE = "mutations.ts";
const MANIFEST_PATH = join(FEATURES_DIR, "fate-live", "fanned-mutations.ts");

/** The gathered facts across all feature mutation files. */
interface GatheredFeatures {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly featurePublishes: FeaturePublishes;
}

/**
 * Enumerate `<root>/apps/web/worker/features/*` and, for each that holds a
 * `mutations.ts`, parse its `Fate.mutation` keys and whether it references a publish.
 */
const gatherFeatures = (root: string): Effect.Effect<GatheredFeatures, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, FEATURES_DIR);
			const entries = readdirSync(base, {withFileTypes: true});
			const discovered: Array<DiscoveredMutation> = [];
			const featurePublishes = new Map<string, boolean>();
			for (const entry of entries) {
				const abs = join(base, entry.name);
				if (!statSync(abs).isDirectory()) continue;
				const mutationsPath = join(abs, MUTATIONS_FILE);
				if (!existsSync(mutationsPath)) continue;
				const source = readFileSync(mutationsPath, "utf8");
				for (const key of parseMutationKeys(source)) {
					discovered.push({key, feature: entry.name});
				}
				featurePublishes.set(entry.name, referencesPublisher(source));
			}
			return {discovered, featurePublishes};
		},
		catch: (cause) => new IoError({path: join(root, FEATURES_DIR), cause}),
	});

/** Read + parse the fanned-mutation manifest; a missing manifest fails closed. */
const readManifest = (
	root: string,
): Effect.Effect<ReadonlyArray<ManifestEntry>, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const manifestPath = join(root, MANIFEST_PATH);
		const text = yield* Effect.try({
			try: () => readFileSync(manifestPath, "utf8"),
			catch: (cause) => new IoError({path: manifestPath, cause}),
		});
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
 * The CI gate: succeed when every worker mutation is classified and every fanned
 * mutation's feature publishes a `/fate/live` invalidation, else `CheckFailed`. Fails
 * closed on zero mutations in scope (ADR 0092).
 */
export const checkFanout = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const manifest = yield* readManifest(root);
		const {discovered, featurePublishes} = yield* gatherFeatures(root);
		const verdict = judge({discovered, manifest, featurePublishes});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
