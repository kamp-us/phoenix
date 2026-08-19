/**
 * `guard fanout-guard check` — a mutation over a fate-live fanned entity publishes its `/fate/live`
 * invalidation, and publishes it at the declared topic (ADR 0155, #1898), ported off
 * `pipeline-cli fanout-guard check` (epic #5720).
 *
 * The verb is the IO boundary and nothing else: gather the manifest, the `LiveTopic` map and each
 * feature's mutation keys / publisher reference / live targets, hand them to the rule in
 * `./fanout.ts`, seat the answer on the group's exit taxonomy.
 *
 * **v1's single non-zero splits into three seats here.** A missing feature dir or an unreadable file
 * is UNKNOWN (`11`) — the scan never completed; zero discovered mutations and a present-but-empty
 * manifest are both a broken scope assumption (`7`, ADR 0092); a real drift, omission or mis-aim is
 * the violation (`12`). All three stay red, so the gate's strictness is unchanged.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, isDirectory, type ReadFailed, readDir, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {type Annotation, atFile} from "./annotate.ts";
import {
	type DiscoveredMutation,
	type FanoutGuardVerdict,
	type FeatureTargets,
	judge,
	MANIFEST_PATH,
	type ManifestEntry,
	parseFeatureDelegations,
	parseFeatureTargets,
	parseLiveTopicMap,
	parseManifestEntries,
	parseMutationKeys,
	referencesPublisher,
	renderReport,
	resolveReachableTargets,
} from "./fanout.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard fanout-guard check";

const FEATURES_DIR = "apps/web/worker/features";
const MUTATIONS_FILE = "mutations.ts";
const LIVE_FILE = "live.ts";
const PROTOCOL_PATH = `${FEATURES_DIR}/fate-live/protocol.ts`;

export interface FanoutGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface GatheredFeatures {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly featurePublishes: ReadonlyMap<string, boolean>;
	readonly featureTargets: FeatureTargets;
}

/**
 * Every feature dir's mutation keys, publisher reference and reachable `/fate/live` targets.
 *
 * `live.ts` is scanned even for a feature with no `mutations.ts`, so a binding that is only ever
 * delegated through (report → pano/sözlük) still contributes its targets to the closure.
 */
const gatherFeatures = (
	root: string,
	liveTopicMap: ReadonlyMap<string, string>,
): Effect.Effect<GatheredFeatures, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const base = path.join(root, FEATURES_DIR);
		const discovered: Array<DiscoveredMutation> = [];
		const featurePublishes = new Map<string, boolean>();
		const directTargets = new Map<string, ReadonlySet<string>>();
		const delegations = new Map<string, ReadonlySet<string>>();
		for (const name of yield* readDir(base)) {
			const dir = path.join(base, name);
			if (!(yield* isDirectory(dir))) continue;
			const mutationsPath = path.join(dir, MUTATIONS_FILE);
			if (yield* exists(mutationsPath)) {
				const source = yield* readFile(mutationsPath);
				for (const key of parseMutationKeys(source)) discovered.push({key, feature: name});
				featurePublishes.set(name, referencesPublisher(source));
			}
			const livePath = path.join(dir, LIVE_FILE);
			if (yield* exists(livePath)) {
				const liveSource = yield* readFile(livePath);
				directTargets.set(name, parseFeatureTargets(liveSource, liveTopicMap));
				delegations.set(name, parseFeatureDelegations(liveSource));
			}
		}
		return {
			discovered,
			featurePublishes,
			featureTargets: resolveReachableTargets(directTargets, delegations),
		};
	});

/**
 * The `LiveTopic` map out of `fate-live/protocol.ts`.
 *
 * An absent protocol file yields an empty map rather than a failure: every declared connection
 * topic then reports as unreachable, which reds loudly — a moved protocol file is a real
 * misconfiguration, not a reason to pass.
 */
const readLiveTopicMap = (
	root: string,
): Effect.Effect<ReadonlyMap<string, string>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const protocolPath = path.join(root, PROTOCOL_PATH);
		if (!(yield* exists(protocolPath))) return new Map<string, string>();
		return parseLiveTopicMap(yield* readFile(protocolPath));
	});

/** Where each offender is annotated, so a red renders on the diff instead of only in the log. */
const annotationsFor = (
	verdict: FanoutGuardVerdict,
	featureOf: ReadonlyMap<string, string>,
): ReadonlyArray<Annotation> => {
	if (verdict.pass) return [];
	if (verdict.reason === "drift") {
		return [
			...verdict.unclassified.map((key) =>
				atFile(
					"error",
					MANIFEST_PATH,
					`\`${key}\` is not classified — add a row deciding fanned: true|false, so a fanned mutation can never silently omit its /fate/live publish (ADR 0155).`,
				),
			),
			...verdict.stale.map((key) =>
				atFile(
					"error",
					MANIFEST_PATH,
					`\`${key}\` no longer exists in the worker — remove the stale manifest row.`,
				),
			),
		];
	}
	if (verdict.reason === "missing-publish") {
		return verdict.omitted.map((key) =>
			atFile(
				"error",
				`${FEATURES_DIR}/${featureOf.get(key) ?? ""}/${MUTATIONS_FILE}`,
				`\`${key}\` is fanned but this feature never reaches WorkerLivePublisher — publish the /fate/live invalidation after the write, or reclassify the mutation fanned: false (ADR 0155).`,
			),
		);
	}
	if (verdict.reason === "topic-mismatch") {
		return [
			...verdict.undeclared.map((key) =>
				atFile(
					"error",
					MANIFEST_PATH,
					`\`${key}\` is fanned but declares no topics: [...] — name the /fate/live target(s) it publishes to (#2554).`,
				),
			),
			...verdict.misaimed.map((m) =>
				atFile(
					"error",
					`${FEATURES_DIR}/${m.feature}/${LIVE_FILE}`,
					`\`${m.key}\` declares ${m.declared.join(", ")} but this binding no longer targets ${m.unreachable.join(", ")} — fix the aim, or correct the manifest row (#2554).`,
				),
			),
		];
	}
	return [];
};

const readManifest = (
	root: string,
): Effect.Effect<ReadonlyArray<ManifestEntry>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		return parseManifestEntries(yield* readFile(path.join(root, MANIFEST_PATH)));
	});

const judgeRoot = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const manifest = yield* readManifest(root);
		if (manifest.length === 0) {
			return zeroScope(
				`${VERB}: parsed ZERO rows from ${MANIFEST_PATH} — the manifest is empty or its row shape changed, so the classification is broken. Fail-closed (ADR 0092/0155).`,
			);
		}
		const liveTopicMap = yield* readLiveTopicMap(root);
		const {discovered, featurePublishes, featureTargets} = yield* gatherFeatures(
			root,
			liveTopicMap,
		);
		const verdict = judge({discovered, manifest, featurePublishes, featureTargets});
		if (verdict.pass) return clean(renderReport(VERB, verdict), verdict.checked);
		const report = renderReport(VERB, verdict);
		if (verdict.reason === "zero-scope") return zeroScope(report);
		const featureOf = new Map(discovered.map((d) => [d.key, d.feature] as const));
		return violation(
			report,
			annotationsOrNone(() => annotationsFor(verdict, featureOf)),
		);
	});

export const runFanoutGuard = (
	options: FanoutGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judgeRoot(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
