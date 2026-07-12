/**
 * `fanout-guard` pure core (ADR 0155) — decide whether every worker `Fate.mutation`
 * is classified in the fanned-mutation manifest, whether every fanned mutation's
 * feature publishes a `/fate/live` invalidation, and whether that publish AIMS at the
 * manifest-declared topic. IO-free and total: every decision is a deterministic
 * transform over already-gathered facts. The filesystem boundary (discover mutation
 * keys per feature, parse the manifest, detect the publisher reference, gather each
 * feature's reachable topics) lives in `gate.ts`; this module never touches disk.
 *
 * Three invariants, each a distinct failure shape:
 *
 *   1. Drift — the discovered mutation-key set EQUALS the manifest's key set. A
 *      discovered key with no manifest row (`unclassified`) OR a manifest row for a
 *      key that no longer exists (`stale`) fails. This forces the conscious fanned/not
 *      decision on every new mutation, which is the moment the publish would otherwise
 *      be silently omitted.
 *   2. Publish — every `fanned: true` mutation's feature references a
 *      `WorkerLivePublisher` publish. A fanned mutation whose feature omits it fails.
 *   3. Topic aim — every `fanned: true` mutation declares its expected `/fate/live`
 *      target(s) in the manifest, and each declared target is reachable from its
 *      feature's `live.ts` binding. Closes the mis-aim class (#2554): invariant 2 only
 *      proves a publish EXISTS; this proves it AIMS at the declared topic. A fanned row
 *      with no declared topic fails (parity with `drift` forcing the classification);
 *      a declared topic the feature's `live.ts` no longer targets (a topic edit that
 *      re-aimed the publish) fails as `topic-mismatch`.
 *
 * A `/fate/live` target is either a connection topic (a `LiveTopic` value, e.g.
 * `posts` / `Post.comments` / `Term.definitions`) or an entity-update typename
 * (`Post` / `Comment` / `Definition` / `User`) — the two shapes a publish can take.
 * The topic check is feature-scoped by construction, exactly as invariant 2 is: it
 * reuses the per-feature `live.ts` scan the way invariant 2 reuses the per-feature
 * publisher scan. It proves the declared topic is still REACHABLE in the feature's
 * binding, not that this exact resolver wired that exact topic — which closes the
 * concrete mis-aim edit (a `LiveTopic.x → LiveTopic.y` swap in `live.ts` drops `x`
 * from the feature's reachable set), the change that passes review and CI today.
 * Reachability resolves one graph of `*Live(...)` delegation: a feature whose
 * `live.ts` publishes THROUGH another feature's binding (report → pano/sözlük)
 * inherits that feature's targets.
 *
 * Fail-closed on zero scope (ADR 0092): zero discovered mutations is a
 * misconfiguration (wrong root, a features-dir reshape), NOT a vacuous pass.
 */

/** One `Fate.mutation` discovered in a feature's `mutations.ts`. */
export interface DiscoveredMutation {
	/** The `entity.verb` mutation key. */
	readonly key: string;
	/** The feature the mutation lives in (`apps/web/worker/features/<feature>`). */
	readonly feature: string;
}

/**
 * One manifest row — a key's fanned classification plus, for a fanned row, the
 * `/fate/live` target(s) it publishes to (a `LiveTopic` value or an entity typename).
 * `topics` is empty for a not-fanned row (nothing to aim) and its presence is required
 * for a fanned row by invariant 3. The rationale is not needed by the core.
 */
export interface ManifestEntry {
	readonly key: string;
	readonly fanned: boolean;
	readonly topics: ReadonlyArray<string>;
}

/**
 * Whether each feature's `mutations.ts` references a `WorkerLivePublisher` publish.
 * Gathered once per feature at the IO boundary (the publish check is feature-scoped,
 * per ADR 0155: a fanned mutation's FEATURE must reach the publisher, not necessarily
 * the exact resolver — features share a `*Live(...)` helper).
 */
export type FeaturePublishes = ReadonlyMap<string, boolean>;

/**
 * The `/fate/live` targets each feature's `live.ts` binding can reach, delegation
 * already resolved (see `resolveReachableTargets`). A fanned mutation's declared topic
 * must be a member of its feature's set — the feature-scoped aim check (invariant 3).
 */
export type FeatureTargets = ReadonlyMap<string, ReadonlySet<string>>;

/** The facts the pure verdict is computed over — all gathered at the IO boundary. */
export interface FanoutGuardFacts {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly manifest: ReadonlyArray<ManifestEntry>;
	readonly featurePublishes: FeaturePublishes;
	readonly featureTargets: FeatureTargets;
}

/** One mis-aimed fanned mutation: its declared topics and the subset the feature can't reach. */
export interface MisaimedMutation {
	readonly key: string;
	readonly feature: string;
	readonly declared: ReadonlyArray<string>;
	/** The declared topics NOT reachable from the feature's `live.ts` — the mis-aim evidence. */
	readonly unreachable: ReadonlyArray<string>;
}

/**
 * The guard verdict — a discriminated union so an invalid state is unrepresentable: a
 * pass never carries a failure list, and each failure shape carries exactly its
 * evidence.
 */
export type FanoutGuardVerdict =
	| {readonly pass: true; readonly checked: number; readonly fanned: number}
	/** No mutations discovered — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	/** Discovered keys and manifest keys disagree — a mutation is unclassified or a row is stale. */
	| {
			readonly pass: false;
			readonly reason: "drift";
			/** Discovered mutations with no manifest row — the conscious decision was skipped. */
			readonly unclassified: ReadonlyArray<string>;
			/** Manifest rows for keys no longer discovered — a stale entry to remove. */
			readonly stale: ReadonlyArray<string>;
	  }
	/** A fanned mutation's feature does not reference a `WorkerLivePublisher` publish. */
	| {
			readonly pass: false;
			readonly reason: "missing-publish";
			/** The `entity.verb` keys whose feature omits the publish. */
			readonly omitted: ReadonlyArray<string>;
	  }
	/**
	 * A fanned mutation's publish does not aim where the manifest declares (#2554):
	 * `undeclared` is a fanned row with no expected topic; `misaimed` is a declared
	 * topic the feature's `live.ts` no longer targets.
	 */
	| {
			readonly pass: false;
			readonly reason: "topic-mismatch";
			readonly undeclared: ReadonlyArray<string>;
			readonly misaimed: ReadonlyArray<MisaimedMutation>;
	  };

/**
 * Decide the verdict over the gathered facts. Order: fail-closed on zero scope, then
 * drift (the key sets must agree), then publish (over the fanned subset), then topic
 * aim. Each stage presupposes the prior: drift before publish because an unclassified
 * key has no `fanned` flag to check a publish against; publish before aim because a
 * feature that omits the publish entirely can't be checked for WHERE it aims.
 */
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

	// Every fanned mutation's feature must reference a publish. Feature-scoped: look up
	// the discovered mutation's feature and assert it publishes.
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

	// Topic aim: each fanned mutation must declare its target(s), and every declared
	// target must be reachable from its feature's live.ts binding.
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

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: FanoutGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`fanout-guard: ${verdict.checked} mutations classified, ` +
			`${verdict.fanned} fanned — every fanned mutation's feature publishes a /fate/live ` +
			"invalidation aimed at its declared topic"
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			"fanout-guard: discovered ZERO Fate.mutation declarations under " +
			"apps/web/worker/features/*/mutations.ts — fail-closed (ADR 0092). Is the repo root " +
			"correct, or did the worker features layout change?"
		);
	}
	if (verdict.reason === "drift") {
		const lines: Array<string> = [];
		if (verdict.unclassified.length > 0) {
			lines.push(
				`  UNCLASSIFIED (${verdict.unclassified.length}) — add a row to ` +
					"apps/web/worker/features/fate-live/fanned-mutations.ts deciding fanned: true|false:",
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
			"fanout-guard: the fanned-mutations manifest is out of sync with the worker's " +
			`Fate.mutation declarations:\n${lines.join("\n")}\n\n` +
			"Every mutation must be classified fanned/not so a fanned mutation can never silently " +
			"omit its /fate/live publish (ADR 0155)."
		);
	}
	if (verdict.reason === "missing-publish") {
		const lines = verdict.omitted.map((k) => `  ${k}`);
		return (
			`fanout-guard: ${verdict.omitted.length} fanned mutation` +
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
				"apps/web/worker/features/fate-live/fanned-mutations.ts naming its /fate/live target(s):",
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
		"fanout-guard: a fanned mutation's /fate/live publish does not aim where the manifest " +
		`declares (#2554):\n${lines.join("\n")}\n\n` +
		"Invariant 2 proves a publish EXISTS; this proves it AIMS at the declared topic. Fix the " +
		"live.ts binding to publish to the declared topic, or correct the manifest row's topics: " +
		"[...] to the topic the feature actually fans into (ADR 0155; .patterns/fate-live-views.md)."
	);
};

/**
 * Extract `{key, fanned, topics}` rows from the manifest module's source text. Pure
 * over the text so `gate.ts` grounds the classification in the checked-in manifest
 * without a cross-package import (pipeline-cli must not depend on apps/web). Reads the
 * `{key: "<entity.verb>", fanned: true|false, topics: [...]? …}` object-literal rows —
 * a minimal, dependency-free slice, sufficient for this file's flat shape, not a
 * general TS parser. `topics` is authored after `fanned` on a fanned row and omitted on
 * a not-fanned one; a missing `topics` parses to `[]` (invariant 3 then flags the
 * fanned row as undeclared).
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

/**
 * Extract the `entity.verb` mutation keys declared in a `mutations.ts` source. Pure
 * over the text: matches `"<entity.verb>": Fate.mutation(` — the exact declaration
 * shape (`.patterns/fate-effect-operations.md`). Dependency-free; sufficient for the
 * declaration shape, not a general TS parser.
 */
export const parseMutationKeys = (source: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const re = /["']([a-zA-Z]+\.[a-zA-Z]+)["']\s*:\s*Fate\.mutation\s*\(/g;
	for (const m of source.matchAll(re)) {
		if (m[1] !== undefined) out.push(m[1]);
	}
	return out;
};

/**
 * Whether a `mutations.ts` source references a `WorkerLivePublisher` publish. The
 * feature-scoped floor (ADR 0155): a fanned mutation's feature must reach the
 * publisher. Matches the greppable convention — `yield* WorkerLivePublisher` (the
 * worker accessor, not the un-narrowed package tag).
 */
export const referencesPublisher = (source: string): boolean => /WorkerLivePublisher/.test(source);

/**
 * Parse the `LiveTopic` object literal from `fate-live/protocol.ts` into a
 * property-name → wire-value map (e.g. `postComments → "Post.comments"`). Scoped to the
 * `export const LiveTopic = { … } as const` block and matched per-line
 * (`<prop>: "<value>"`), so the interspersed docblock prose can't be mistaken for an
 * entry. This resolves the `LiveTopic.<prop>` references a `live.ts` binding uses back
 * to the wire topics the manifest declares.
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
 * The `/fate/live` targets a feature's `live.ts` binding references DIRECTLY (before
 * delegation resolution). Two shapes, matching how a publish is wired:
 *
 *   - connection topics — a `LiveTopic.<prop>` reference, resolved to its wire value
 *     via `liveTopicMap` (an unknown prop, e.g. a typo, resolves to nothing);
 *   - entity updates — an `<Entity>View.typeName` reference, whose value equals the
 *     view name minus its `View` suffix (`PostView.typeName === "Post"`, the ADR-0155
 *     view-sourced-typename convention, #1127). Anchored on `.typeName` so an unrelated
 *     `<Name>View` mention can't be mistaken for a publish target.
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
 * The features a `live.ts` binding delegates to — the `<feature>Live(` helpers it calls
 * (report's binding publishes THROUGH `panoLive(...)` / `sozlukLive(...)`). Captures the
 * lowercase-led `<name>` before the `Live(` call so it can't match `WorkerLivePublisher`
 * (uppercase-led, no trailing `(`); a self-reference is dropped in the closure.
 */
export const parseFeatureDelegations = (liveSource: string): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const m of liveSource.matchAll(/\b([a-z]\w*)Live\s*\(/g)) {
		if (m[1] !== undefined) out.add(m[1]);
	}
	return out;
};

/**
 * Resolve each feature's REACHABLE targets: its direct targets unioned with those of
 * every feature it delegates to, transitively (a bounded fixpoint over the small
 * feature graph). A feature that only appears as a delegation target still gets an
 * entry. Self-delegation is a no-op.
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
