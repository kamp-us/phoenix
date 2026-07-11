/**
 * `reachability-guard` pure core (ADR 0173) — decide whether a Flagship flag key is
 * *reachable*: its vertical's user-facing slice is built before the flag can graduate
 * to 100%. IO-free and total: every decision is a deterministic transform over
 * already-gathered facts. The filesystem boundary (read `keys.ts`, walk the SPA `.tsx`
 * source, walk the e2e specs) lives in `gate.ts`; this module never touches disk.
 *
 * Per ADR 0173 §1 a flag is reachable iff BOTH assertions hold, unless it is exempt:
 *   (a) a consuming UI exists — ≥1 `apps/web/src/**\/*.tsx` references the flag-key
 *       constant declared in `apps/web/src/flags/keys.ts`, beyond the definition itself
 *       (the exact static scan the reactions reporter ran by hand);
 *   (b) a registered journey e2e exists — a spec under `apps/web/tests/e2e/` bears the
 *       in-title `@journey:<flag-key>` tag (ADR 0173 §2; the checker asserts *registration*,
 *       never runs playwright).
 *
 * The exemption model (ADR 0173 §3): a legitimately UI-less infra/containment flag opts
 * out with a stated reason via a `@reachability-exempt: <reason>` marker in its `keys.ts`
 * doc-comment. An exempt flag graduates without a UI consumer or a journey — because a
 * human wrote down *why* it has no UI. There is no silent skip and no blanket allowlist.
 *
 * Fail-closed on zero scope (ADR 0092): zero parsed flag definitions is a broken scope
 * assumption (wrong root, a `keys.ts` reshape), NOT a vacuous pass; an unknown/unclassified
 * flag key is likewise a failure, never a silent pass (ADR 0173 §1).
 */

/** One flag declared in `apps/web/src/flags/keys.ts`. */
export interface FlagDefinition {
	/** The exported constant name — e.g. `PHOENIX_REACTIONS` (the token a `.tsx` consumer imports). */
	readonly constantName: string;
	/** The flag-key string the constant binds — e.g. `phoenix-reactions` (the Flagship key). */
	readonly flagKey: string;
	/** The stated reason from a `@reachability-exempt: <reason>` marker, or null when unmarked. */
	readonly exemptReason: string | null;
}

/** The facts the pure verdict is computed over — all gathered at the IO boundary (`gate.ts`). */
export interface ReachabilityFacts {
	/** The flag key the run was asked to check. */
	readonly flagKey: string;
	/** Every flag parsed from `keys.ts`. */
	readonly definitions: ReadonlyArray<FlagDefinition>;
	/** Constant names referenced by ≥1 `apps/web/src/**\/*.tsx` (the `.tsx` walk excludes `keys.ts`). */
	readonly consumingConstants: ReadonlySet<string>;
	/** Flag keys carrying a `@journey:<key>` tag in some `apps/web/tests/e2e/` spec. */
	readonly journeyKeys: ReadonlySet<string>;
}

/**
 * The guard verdict — a discriminated union so an invalid state is unrepresentable: a
 * pass never carries a failure list, and each failure shape carries exactly its evidence.
 */
export type ReachabilityVerdict =
	| {readonly pass: true; readonly flagKey: string; readonly mode: "reachable"}
	| {
			readonly pass: true;
			readonly flagKey: string;
			readonly mode: "exempt";
			readonly exemptReason: string;
	  }
	/** No flag definitions parsed at all — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly flagKey: string; readonly reason: "zero-scope"}
	/** The requested key is not declared in `keys.ts` — unclassified, fail closed (ADR 0173 §1). */
	| {readonly pass: false; readonly flagKey: string; readonly reason: "unknown-flag"}
	/** A user-facing flag missing its UI consumer and/or its journey e2e. */
	| {
			readonly pass: false;
			readonly flagKey: string;
			readonly reason: "unreachable";
			readonly constantName: string;
			readonly missingConsumer: boolean;
			readonly missingJourney: boolean;
	  };

/**
 * Decide the verdict over the gathered facts. Order: fail-closed on zero scope, then
 * resolve the requested key (unknown ⇒ fail), then honor an exemption before the two
 * assertions (an exempt flag needs neither a consumer nor a journey — ADR 0173 §3), then
 * assert consumer + journey.
 */
export const judge = (facts: ReachabilityFacts): ReachabilityVerdict => {
	const {flagKey, definitions, consumingConstants, journeyKeys} = facts;

	if (definitions.length === 0) {
		return {pass: false, flagKey, reason: "zero-scope"};
	}

	const def = definitions.find((d) => d.flagKey === flagKey);
	if (def === undefined) {
		return {pass: false, flagKey, reason: "unknown-flag"};
	}

	if (def.exemptReason !== null) {
		return {pass: true, flagKey, mode: "exempt", exemptReason: def.exemptReason};
	}

	const missingConsumer = !consumingConstants.has(def.constantName);
	const missingJourney = !journeyKeys.has(flagKey);
	if (missingConsumer || missingJourney) {
		return {
			pass: false,
			flagKey,
			reason: "unreachable",
			constantName: def.constantName,
			missingConsumer,
			missingJourney,
		};
	}

	return {pass: true, flagKey, mode: "reachable"};
};

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: ReachabilityVerdict): string => {
	if (verdict.pass) {
		if (verdict.mode === "exempt") {
			return (
				`reachability-guard: ${verdict.flagKey} is @reachability-exempt — passing without a UI ` +
				`consumer or journey e2e. Stated reason: ${verdict.exemptReason}`
			);
		}
		return (
			`reachability-guard: ${verdict.flagKey} is reachable — a consuming .tsx references its ` +
			"keys.ts constant AND a @journey-tagged e2e is registered."
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			"reachability-guard: parsed ZERO flag definitions from apps/web/src/flags/keys.ts — " +
			"fail-closed (ADR 0092). Is the repo root correct, or did the flag-key module layout change?"
		);
	}
	if (verdict.reason === "unknown-flag") {
		return (
			`reachability-guard: '${verdict.flagKey}' is not declared in apps/web/src/flags/keys.ts — ` +
			"an unknown/unclassified flag key fails closed (ADR 0173 §1). Add the flag-key constant, or " +
			"check the key you passed."
		);
	}
	const lines: Array<string> = [];
	if (verdict.missingConsumer) {
		lines.push(
			`  MISSING UI CONSUMER — no apps/web/src/**/*.tsx references ${verdict.constantName} ` +
				`(the keys.ts constant for ${verdict.flagKey}). Build + wire the user-facing slice, or, if ` +
				"the flag is UI-less by design, mark it @reachability-exempt: <reason> at its keys.ts definition.",
		);
	}
	if (verdict.missingJourney) {
		lines.push(
			`  MISSING JOURNEY E2E — no spec under apps/web/tests/e2e/ carries a @journey:${verdict.flagKey} ` +
				"tag. Tag the vertical's journey spec's test/describe title with it (ADR 0173 §2).",
		);
	}
	return (
		`reachability-guard: ${verdict.flagKey} is UNREACHABLE — its vertical's user-facing slice is ` +
		`unbuilt, so it must not graduate to 100% (ADR 0173):\n${lines.join("\n")}`
	);
};

/**
 * Extract every `{constantName, flagKey, exemptReason}` row from the `keys.ts` source.
 * Pure over the text so `gate.ts` grounds the scan in the checked-in module without a
 * cross-package import (pipeline-cli must not depend on apps/web). Matches the module's
 * flat `export const NAME = "flag-key";` shape and pairs each with the doc-comment
 * immediately preceding it (only whitespace between) to read an optional
 * `@reachability-exempt: <reason>` marker. Dependency-free; sufficient for this file's
 * shape, not a general TS parser.
 */
export const parseFlagDefinitions = (source: string): ReadonlyArray<FlagDefinition> => {
	const comments: Array<{readonly end: number; readonly body: string}> = [];
	const commentRe = /\/\*\*([\s\S]*?)\*\//g;
	for (const m of source.matchAll(commentRe)) {
		if (m.index !== undefined && m[1] !== undefined) {
			comments.push({end: m.index + m[0].length, body: m[1]});
		}
	}

	const out: Array<FlagDefinition> = [];
	const defRe = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([a-z0-9-]+)["']/g;
	for (const m of source.matchAll(defRe)) {
		const constantName = m[1];
		const flagKey = m[2];
		if (constantName === undefined || flagKey === undefined || m.index === undefined) continue;
		const exemptReason = exemptReasonForDefinition(source, comments, m.index);
		out.push({constantName, flagKey, exemptReason});
	}
	return out;
};

/**
 * The exemption reason attached to the definition starting at `defStart`, or null. The
 * marker is honored only from the doc-comment IMMEDIATELY preceding the definition (only
 * whitespace between comment end and the `export`) — a distant comment never leaks its
 * marker onto an unrelated flag.
 */
const exemptReasonForDefinition = (
	source: string,
	comments: ReadonlyArray<{readonly end: number; readonly body: string}>,
	defStart: number,
): string | null => {
	let nearest: {readonly end: number; readonly body: string} | undefined;
	for (const c of comments) {
		if (c.end <= defStart && /^\s*$/.test(source.slice(c.end, defStart))) {
			if (nearest === undefined || c.end > nearest.end) nearest = c;
		}
	}
	if (nearest === undefined) return null;
	const marker = nearest.body.match(/@reachability-exempt:\s*(.+)/);
	if (marker?.[1] === undefined) return null;
	return (
		marker[1]
			.trim()
			.replace(/\s*\*\/?\s*$/, "")
			.trim() || null
	);
};

/**
 * Which of `candidateNames` appear as a whole-word reference in a `.tsx` source. The
 * consuming-UI signal (ADR 0173 §1a): a constant referenced by a component — an import,
 * a `useFlag(NAME)`, a `<FlagGate flag={NAME}>`. Whole-word so `PANO_BASE_FEED` never
 * matches inside `PANO_BASE_FEED_EDGE` and vice-versa.
 */
export const consumedConstantsIn = (
	source: string,
	candidateNames: ReadonlyArray<string>,
): ReadonlyArray<string> =>
	candidateNames.filter((name) => new RegExp(`\\b${name}\\b`).test(source));

/**
 * The flag keys a spec registers via `@journey:<flag-key>` tags in its source (ADR 0173
 * §2). Pure over the spec text; the tag lives in a `test`/`describe` title but a plain
 * text scan is sufficient to assert *registration* (the e2e job runs the spec).
 */
export const parseJourneyTags = (source: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const re = /@journey:([a-z0-9-]+)/g;
	for (const m of source.matchAll(re)) {
		if (m[1] !== undefined) out.push(m[1]);
	}
	return out;
};
