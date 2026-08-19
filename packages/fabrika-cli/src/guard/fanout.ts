/**
 * `fanout-guard`'s pure half — is every worker `Fate.mutation` classified in the fanned-mutation
 * manifest, does every fanned mutation's feature publish a `/fate/live` invalidation, and does that
 * publish AIM at the manifest-declared topic? See ADR 0155 for the why; #1893–#1896 all shipped the
 * silent omission this rule exists to catch.
 *
 * Three invariants, judged in order, because each presupposes the prior: drift first (an
 * unclassified key has no `fanned` flag to check a publish against), then publish (a feature that
 * omits the publish entirely cannot be checked for WHERE it aims), then topic aim.
 *
 * The topic check is feature-scoped the same way the publish check is — it proves the declared
 * topic is still REACHABLE from the feature's `live.ts`, not that one exact resolver wired it. That
 * is what catches the concrete mis-aim edit of #2554: a `LiveTopic.x → LiveTopic.y` swap in
 * `live.ts` drops `x` from the feature's reachable set, and nothing else in review or CI sees it.
 *
 * The parsers below are minimal text slices, not a TS parse: fabrika-cli must not depend on
 * apps/web, so the classification is grounded in the checked-in source text instead of imported.
 */

/** One `Fate.mutation` discovered in a feature's `mutations.ts`. */
export interface DiscoveredMutation {
	readonly key: string;
	/** The feature dir under `apps/web/worker/features`. */
	readonly feature: string;
}

/**
 * One manifest row. `topics` is the `/fate/live` target(s) a fanned row publishes to — a
 * `LiveTopic` wire value or an entity typename — and is empty for a not-fanned row, which has
 * nothing to aim.
 */
export interface ManifestEntry {
	readonly key: string;
	readonly fanned: boolean;
	readonly topics: ReadonlyArray<string>;
}

/** Whether each feature's `mutations.ts` references a `WorkerLivePublisher` publish. */
export type FeaturePublishes = ReadonlyMap<string, boolean>;

/** The `/fate/live` targets each feature reaches, delegation already resolved. */
export type FeatureTargets = ReadonlyMap<string, ReadonlySet<string>>;

export interface FanoutGuardFacts {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly manifest: ReadonlyArray<ManifestEntry>;
	readonly featurePublishes: FeaturePublishes;
	readonly featureTargets: FeatureTargets;
}

/** One mis-aimed fanned mutation: its declared topics and the subset its feature cannot reach. */
export interface MisaimedMutation {
	readonly key: string;
	readonly feature: string;
	readonly declared: ReadonlyArray<string>;
	readonly unreachable: ReadonlyArray<string>;
}

/** The verdict — a union, so a pass can never carry a failure list and each shape carries only its own evidence. */
export type FanoutGuardVerdict =
	| {readonly pass: true; readonly checked: number; readonly fanned: number}
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {
			readonly pass: false;
			readonly reason: "drift";
			/** Discovered mutations with no manifest row — the conscious fanned/not decision was skipped. */
			readonly unclassified: ReadonlyArray<string>;
			/** Manifest rows for keys no longer discovered. */
			readonly stale: ReadonlyArray<string>;
	  }
	| {
			readonly pass: false;
			readonly reason: "missing-publish";
			readonly omitted: ReadonlyArray<string>;
	  }
	| {
			readonly pass: false;
			readonly reason: "topic-mismatch";
			/** Fanned rows that declare no topic at all — parity with drift forcing the classification. */
			readonly undeclared: ReadonlyArray<string>;
			readonly misaimed: ReadonlyArray<MisaimedMutation>;
	  };

export const judge = (facts: FanoutGuardFacts): FanoutGuardVerdict => {
	const {discovered, manifest, featurePublishes, featureTargets} = facts;

	if (discovered.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}

	const discoveredKeys = new Set(discovered.map((d) => d.key));
	const manifestByKey = new Map(manifest.map((m) => [m.key, m] as const));

	const unclassified = [...discoveredKeys].filter((k) => !manifestByKey.has(k)).sort();
	const stale = manifest
		.map((m) => m.key)
		.filter((k) => !discoveredKeys.has(k))
		.sort();
	if (unclassified.length > 0 || stale.length > 0) {
		return {pass: false, reason: "drift", unclassified, stale};
	}

	const featureOf = new Map(discovered.map((d) => [d.key, d.feature] as const));
	const fannedKeys = discovered
		.map((d) => d.key)
		.filter((k) => manifestByKey.get(k)?.fanned === true);
	const omitted = fannedKeys
		.filter((k) => featurePublishes.get(featureOf.get(k) ?? "") !== true)
		.sort();
	if (omitted.length > 0) {
		return {pass: false, reason: "missing-publish", omitted};
	}

	const undeclared: Array<string> = [];
	const misaimed: Array<MisaimedMutation> = [];
	for (const key of fannedKeys) {
		const declared = manifestByKey.get(key)?.topics ?? [];
		if (declared.length === 0) {
			undeclared.push(key);
			continue;
		}
		const feature = featureOf.get(key) ?? "";
		const reachable = featureTargets.get(feature) ?? new Set<string>();
		const unreachable = declared.filter((t) => !reachable.has(t)).sort();
		if (unreachable.length > 0) misaimed.push({key, feature, declared, unreachable});
	}
	if (undeclared.length > 0 || misaimed.length > 0) {
		return {
			pass: false,
			reason: "topic-mismatch",
			undeclared: undeclared.sort(),
			misaimed: misaimed.sort((a, b) => a.key.localeCompare(b.key)),
		};
	}

	return {pass: true, checked: discovered.length, fanned: fannedKeys.length};
};

export const MANIFEST_PATH = "apps/web/worker/features/fate-live/fanned-mutations.ts";

/** The report a human reads off a red — it names what was scanned and every offender (ADR 0092 §1). */
export const renderReport = (verb: string, verdict: FanoutGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`${verb}: ${verdict.checked} mutations classified, ${verdict.fanned} fanned — every fanned ` +
			"mutation's feature publishes a /fate/live invalidation aimed at its declared topic"
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`${verb}: discovered ZERO Fate.mutation declarations under ` +
			"apps/web/worker/features/*/mutations.ts — fail-closed (ADR 0092). Is the repo root " +
			"correct, or did the worker features layout change?"
		);
	}
	if (verdict.reason === "drift") {
		const lines: Array<string> = [];
		if (verdict.unclassified.length > 0) {
			lines.push(
				`  UNCLASSIFIED (${verdict.unclassified.length}) — add a row to ${MANIFEST_PATH} ` +
					"deciding fanned: true|false:",
			);
			for (const k of verdict.unclassified) lines.push(`    ${k}`);
		}
		if (verdict.stale.length > 0) {
			lines.push(
				`  STALE (${verdict.stale.length}) — manifest rows for mutations that no longer exist; remove them:`,
			);
			for (const k of verdict.stale) lines.push(`    ${k}`);
		}
		return (
			`${verb}: the fanned-mutations manifest is out of sync with the worker's ` +
			`Fate.mutation declarations:\n${lines.join("\n")}\n\n` +
			"Every mutation must be classified fanned/not so a fanned mutation can never silently " +
			"omit its /fate/live publish (ADR 0155)."
		);
	}
	if (verdict.reason === "missing-publish") {
		const lines = verdict.omitted.map((k) => `  ${k}`);
		return (
			`${verb}: ${verdict.omitted.length} fanned mutation` +
			`${verdict.omitted.length === 1 ? "" : "s"} whose feature omits the /fate/live publish:\n` +
			`${lines.join("\n")}\n\n` +
			"A fanned mutation writes an entity in a subscribed connection, so it MUST publish the " +
			"invalidation through WorkerLivePublisher after the write — else every other client's live " +
			"view goes stale (ADR 0155; .patterns/fate-live-views.md). Add the publish, or reclassify " +
			"the mutation fanned: false in the manifest if it truly fans nothing."
		);
	}
	const lines: Array<string> = [];
	if (verdict.undeclared.length > 0) {
		lines.push(
			`  UNDECLARED-TOPIC (${verdict.undeclared.length}) — add topics: [...] to the fanned row in ` +
				`${MANIFEST_PATH} naming its /fate/live target(s):`,
		);
		for (const k of verdict.undeclared) lines.push(`    ${k}`);
	}
	if (verdict.misaimed.length > 0) {
		lines.push(
			`  MIS-AIMED (${verdict.misaimed.length}) — declared topic(s) the feature's live.ts no longer targets:`,
		);
		for (const m of verdict.misaimed) {
			lines.push(`    ${m.key} (${m.feature}) → unreachable: ${m.unreachable.join(", ")}`);
		}
	}
	return (
		`${verb}: a fanned mutation's /fate/live publish does not aim where the manifest ` +
		`declares (#2554):\n${lines.join("\n")}\n\n` +
		"Invariant 2 proves a publish EXISTS; this proves it AIMS at the declared topic. Fix the " +
		"live.ts binding to publish to the declared topic, or correct the manifest row's topics: " +
		"[...] to the topic the feature actually fans into (ADR 0155; .patterns/fate-live-views.md)."
	);
};

/**
 * The `{key, fanned, topics}` rows in the manifest module's source text. `topics` is authored after
 * `fanned` on a fanned row and omitted on a not-fanned one; a missing `topics` parses to `[]`, and
 * invariant 3 then flags the fanned row as undeclared.
 */
export const parseManifestEntries = (source: string): ReadonlyArray<ManifestEntry> => {
	const out: Array<ManifestEntry> = [];
	const re =
		/\bkey:\s*["']([a-zA-Z]+\.[a-zA-Z]+)["']\s*,\s*fanned:\s*(true|false)\b\s*,?\s*(?:topics:\s*\[([^\]]*)\])?/g;
	for (const m of source.matchAll(re)) {
		const key = m[1];
		const fanned = m[2];
		if (key === undefined || fanned === undefined) continue;
		const topicsRaw = m[3];
		const topics = topicsRaw
			? [...topicsRaw.matchAll(/["']([^"']+)["']/g)].map((t) => t[1] as string)
			: [];
		out.push({key, fanned: fanned === "true", topics});
	}
	return out;
};

/** The `entity.verb` keys a `mutations.ts` declares — the `"<key>": Fate.mutation(` shape (.patterns/fate-effect-operations.md). */
export const parseMutationKeys = (source: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const re = /["']([a-zA-Z]+\.[a-zA-Z]+)["']\s*:\s*Fate\.mutation\s*\(/g;
	for (const m of source.matchAll(re)) {
		if (m[1] !== undefined) out.push(m[1]);
	}
	return out;
};

/** Whether a `mutations.ts` reaches the publisher — the worker accessor, not the un-narrowed package tag. */
export const referencesPublisher = (source: string): boolean => /WorkerLivePublisher/.test(source);

/**
 * The `LiveTopic` property → wire-value map (`postComments → "Post.comments"`), which resolves the
 * `LiveTopic.<prop>` refs a `live.ts` uses back to the wire topics the manifest declares.
 *
 * Scoped to the `export const LiveTopic = { … } as const` block and matched per-line, so the
 * interspersed docblock prose cannot be read as an entry.
 */
export const parseLiveTopicMap = (protocolSource: string): ReadonlyMap<string, string> => {
	const out = new Map<string, string>();
	const block = /export const LiveTopic\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(protocolSource);
	if (block?.[1] === undefined) return out;
	for (const m of block[1].matchAll(/^\s*([A-Za-z]\w*):\s*"([^"]+)"/gm)) {
		if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
	}
	return out;
};

/**
 * The `/fate/live` targets a feature's `live.ts` references DIRECTLY, in the two shapes a publish
 * takes: a `LiveTopic.<prop>` ref resolved through `liveTopicMap`, and an `<Entity>View.typeName`
 * ref whose value is the view name minus its `View` suffix (ADR 0155's view-sourced typename, #1127).
 * Anchored on `.typeName` so an unrelated `<Name>View` mention is not read as a target.
 */
export const parseFeatureTargets = (
	liveSource: string,
	liveTopicMap: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const m of liveSource.matchAll(/\bLiveTopic\.(\w+)/g)) {
		const value = m[1] !== undefined ? liveTopicMap.get(m[1]) : undefined;
		if (value !== undefined) out.add(value);
	}
	for (const m of liveSource.matchAll(/\b([A-Z]\w*)View\.typeName\b/g)) {
		if (m[1] !== undefined) out.add(m[1]);
	}
	return out;
};

/**
 * The features a `live.ts` publishes THROUGH — the `<feature>Live(` helpers it calls (report's
 * binding goes through `panoLive(...)` / `sozlukLive(...)`).
 *
 * The captured name is lowercase-led on purpose: that is what keeps `WorkerLivePublisher`
 * (uppercase-led, no trailing `(`) out of the delegation set.
 */
export const parseFeatureDelegations = (liveSource: string): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const m of liveSource.matchAll(/\b([a-z]\w*)Live\s*\(/g)) {
		if (m[1] !== undefined) out.add(m[1]);
	}
	return out;
};

/**
 * Each feature's REACHABLE targets: its direct ones unioned with those of every feature it
 * delegates to, transitively — a bounded fixpoint over the small feature graph. A feature that only
 * appears as a delegation target still gets an entry; self-delegation is a no-op.
 */
export const resolveReachableTargets = (
	direct: ReadonlyMap<string, ReadonlySet<string>>,
	delegations: ReadonlyMap<string, ReadonlySet<string>>,
): FeatureTargets => {
	const result = new Map<string, Set<string>>();
	for (const [feature, targets] of direct) result.set(feature, new Set(targets));
	for (const feature of delegations.keys())
		if (!result.has(feature)) result.set(feature, new Set());

	let changed = true;
	while (changed) {
		changed = false;
		for (const [feature, deps] of delegations) {
			const set = result.get(feature);
			if (set === undefined) continue;
			for (const dep of deps) {
				if (dep === feature) continue;
				const depSet = result.get(dep);
				if (depSet === undefined) continue;
				for (const t of depSet) {
					if (!set.has(t)) {
						set.add(t);
						changed = true;
					}
				}
			}
		}
	}
	return result;
};
