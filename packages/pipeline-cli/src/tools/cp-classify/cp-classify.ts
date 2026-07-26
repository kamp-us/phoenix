/**
 * `cp-classify` pure core — the §CP classification that **cannot hand back a fail-open
 * "not control plane"** (issue #4161).
 *
 * §CP membership has TWO independent sources: the path regex `CONTROL_PLANE_RE` and the
 * ADR-0164 guard-touching-ADR CONTENT probe. A path-only site answers only the first, and its
 * "no path matched" result was being read as the authoritative "this is ordinary work" —
 * which is wrong for exactly the shape that matters: a guard-touching `.decisions/**` ADR is
 * §CP by content with ZERO path matches (live instance: PR #4134, both files `.decisions/**`).
 * The error direction is fail-open: the guard-relaxing change reads as product work.
 *
 * The fix is to make the path-only answer **unrepresentable as a verdict**. This core never
 * returns a bare boolean; it returns one of four states, and only ONE of them
 * (`not-control-plane`) means "proven ordinary" — reached only when the path regex cleared
 * AND no content-classified file is in the set, so there is nothing left for the content probe
 * to decide. Every other outcome is a HOLD the caller must resolve or refuse:
 *
 *   - `control-plane`        — a path matched. Authoritative §CP; no content probe needed.
 *   - `content-undetermined` — no path matched, but the set contains `.decisions/**` files.
 *                              NOT a verdict: the caller MUST run `guard-content-probe` on each
 *                              listed ADR at head before it may claim non-§CP.
 *   - `not-control-plane`    — proven ordinary (path clear + no content-classified file).
 *   - `unknown`              — the classification could not be made (unresolvable boundary, or
 *                              an empty file set). Read-failed and genuinely-non-§CP are
 *                              DIFFERENT FACTS; collapsing them is the recurring fail-open
 *                              defect (#3715, #4108, #4171, #4191), so `unknown` is its own
 *                              state and never degrades to `not-control-plane`.
 *
 * Single-sourced, both axes (#2761 / ADR 0164): the boundary regex is passed IN by the caller
 * (the merge-deciding gates re-resolve it from `origin/main`, #981 — this core never reads a
 * snapshot), and the content-clause SCOPE lives here once as `CP_CONTENT_PREFIX`, imported by
 * `trivial-diff` rather than re-declared. No second copy of either.
 *
 * The over-match direction is deliberately NOT widened (#2617): `content-undetermined` is an
 * obligation to probe, not a §CP verdict — resolving it runs the existing ADR-0164 probe
 * unchanged, so a non-guard-touching ADR still resolves to ordinary.
 */

/**
 * The path prefix the ADR-0164 content clause is scoped to. §CP-by-content is defined over
 * `.decisions/**` ADRs and nothing else, so a file set with no such file has no unresolved
 * content axis — that is what makes `not-control-plane` provable rather than merely unmatched.
 */
export const CP_CONTENT_PREFIX = ".decisions/";

/** True for a file whose §CP membership can be decided by CONTENT (ADR 0164), not just by path. */
export const isContentClassifiedPath = (path: string): boolean =>
	path.startsWith(CP_CONTENT_PREFIX);

/**
 * The four-state §CP answer. Only `not-control-plane` is a proven-ordinary verdict; the other
 * three are holds. There is deliberately no state that means "path said no, content unchecked,
 * treat as ordinary" — that state is the defect this type removes.
 */
export type CpState = "control-plane" | "content-undetermined" | "not-control-plane" | "unknown";

/** Why the classifier landed where it did — surfaced verbatim on the human reason line. */
export type CpReason =
	| "boundary-unresolved"
	| "boundary-uncompilable"
	| "empty-file-set"
	| "path-match"
	| "content-source-present"
	| "path-clear-no-content-source";

export interface CpClassification {
	readonly state: CpState;
	readonly reason: CpReason;
	/** The first path that matched `CONTROL_PLANE_RE`, when `state` is `control-plane`. */
	readonly matchedPath?: string;
	/**
	 * The content-classified files the caller must probe, when `state` is `content-undetermined`.
	 * Empty for every other state.
	 */
	readonly contentSources: ReadonlyArray<string>;
}

/**
 * Classify a changed-file set against the live §CP path boundary. Pure and total.
 *
 * Resolution order — the unresolvable cases come FIRST so a broken input can never fall through
 * to a proven-ordinary answer:
 *   1. `controlPlaneRe` null / blank ⇒ `unknown` (`boundary-unresolved`).
 *   2. `controlPlaneRe` won't compile ⇒ `unknown` (`boundary-uncompilable`) — a broken boundary
 *      must never silently match nothing (ADR 0092 §ZS).
 *   3. no files ⇒ `unknown` (`empty-file-set`) — zero scope is not evidence of innocence.
 *   4. any path matches ⇒ `control-plane`.
 *   5. any `.decisions/**` file present ⇒ `content-undetermined` — the caller owes a content probe.
 *   6. otherwise ⇒ `not-control-plane`, the one proven-ordinary verdict.
 *
 * Blank entries are dropped before step 3, so a trailing newline in a piped file list does not
 * masquerade as a changed file.
 */
export const classifyControlPlane = (
	files: ReadonlyArray<string>,
	controlPlaneRe: string | null | undefined,
): CpClassification => {
	if (controlPlaneRe === null || controlPlaneRe === undefined || controlPlaneRe.trim() === "") {
		return {state: "unknown", reason: "boundary-unresolved", contentSources: []};
	}
	let cp: RegExp;
	try {
		cp = new RegExp(controlPlaneRe);
	} catch {
		return {state: "unknown", reason: "boundary-uncompilable", contentSources: []};
	}

	const paths = files.map((f) => f.trim()).filter((f) => f !== "");
	if (paths.length === 0) {
		return {state: "unknown", reason: "empty-file-set", contentSources: []};
	}

	const matchedPath = paths.find((p) => cp.test(p));
	if (matchedPath !== undefined) {
		return {state: "control-plane", reason: "path-match", matchedPath, contentSources: []};
	}

	const contentSources = paths.filter(isContentClassifiedPath);
	if (contentSources.length > 0) {
		return {state: "content-undetermined", reason: "content-source-present", contentSources};
	}

	return {state: "not-control-plane", reason: "path-clear-no-content-source", contentSources: []};
};

/**
 * Is this state a HOLD — anything other than the one proven-ordinary verdict?
 *
 * This is the predicate the CLI's exit code mirrors, over the four states the classifier can
 * reach. It does NOT extend to whether the classifier ran at all — a caller asserts ordinariness
 * on the stdout state word, never on a bare non-zero exit (see the tool README).
 */
export const isHold = (state: CpState): boolean => state !== "not-control-plane";
