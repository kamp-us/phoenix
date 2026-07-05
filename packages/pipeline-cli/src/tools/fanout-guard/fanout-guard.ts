/**
 * `fanout-guard` pure core (ADR 0155) — decide whether every worker `Fate.mutation`
 * is classified in the fanned-mutation manifest, and whether every fanned mutation's
 * feature publishes a `/fate/live` invalidation. IO-free and total: every decision is
 * a deterministic transform over already-gathered facts. The filesystem boundary
 * (discover mutation keys per feature, parse the manifest, detect the publisher
 * reference) lives in `gate.ts`; this module never touches disk.
 *
 * Two invariants, each a distinct failure shape:
 *
 *   1. Drift — the discovered mutation-key set EQUALS the manifest's key set. A
 *      discovered key with no manifest row (`unclassified`) OR a manifest row for a
 *      key that no longer exists (`stale`) fails. This forces the conscious fanned/not
 *      decision on every new mutation, which is the moment the publish would otherwise
 *      be silently omitted.
 *   2. Publish — every `fanned: true` mutation's feature references a
 *      `WorkerLivePublisher` publish. A fanned mutation whose feature omits it fails.
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

/** One manifest row — a key's fanned classification (the rationale is not needed by the core). */
export interface ManifestEntry {
	readonly key: string;
	readonly fanned: boolean;
}

/**
 * Whether each feature's `mutations.ts` references a `WorkerLivePublisher` publish.
 * Gathered once per feature at the IO boundary (the publish check is feature-scoped,
 * per ADR 0155: a fanned mutation's FEATURE must reach the publisher, not necessarily
 * the exact resolver — features share a `*Live(...)` helper).
 */
export type FeaturePublishes = ReadonlyMap<string, boolean>;

/** The facts the pure verdict is computed over — all gathered at the IO boundary. */
export interface FanoutGuardFacts {
	readonly discovered: ReadonlyArray<DiscoveredMutation>;
	readonly manifest: ReadonlyArray<ManifestEntry>;
	readonly featurePublishes: FeaturePublishes;
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
	  };

/**
 * Decide the verdict over the gathered facts. Order: fail-closed on zero scope, then
 * the drift check (the key sets must agree), then the publish check over the fanned
 * subset. Drift is checked before publish because an unclassified key has no `fanned`
 * flag to check a publish against — the classification must exist first.
 */
export const judge = (facts: FanoutGuardFacts): FanoutGuardVerdict => {
	const {discovered, manifest, featurePublishes} = facts;

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

	return {pass: true, checked: discovered.length, fanned: fannedKeys.length};
};

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: FanoutGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`fanout-guard: ${verdict.checked} mutations classified, ` +
			`${verdict.fanned} fanned — every fanned mutation's feature publishes a /fate/live invalidation`
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
};

/**
 * Extract `{key, fanned}` rows from the manifest module's source text. Pure over the
 * text so `gate.ts` grounds the classification in the checked-in manifest without a
 * cross-package import (pipeline-cli must not depend on apps/web). Reads the
 * `{key: "<entity.verb>", fanned: true|false, …}` object-literal rows the manifest
 * declares — a minimal, dependency-free slice, sufficient for this file's flat shape,
 * not a general TS parser.
 */
export const parseManifestEntries = (source: string): ReadonlyArray<ManifestEntry> => {
	const out: Array<ManifestEntry> = [];
	// Match each `{ key: "x.y", fanned: true|false, … }` row. `key` and `fanned` are
	// authored in that order in the manifest; the rationale that follows is ignored.
	const re = /\bkey:\s*["']([a-zA-Z]+\.[a-zA-Z]+)["']\s*,\s*fanned:\s*(true|false)\b/g;
	for (const m of source.matchAll(re)) {
		const key = m[1];
		const fanned = m[2];
		if (key !== undefined && fanned !== undefined) {
			out.push({key, fanned: fanned === "true"});
		}
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
