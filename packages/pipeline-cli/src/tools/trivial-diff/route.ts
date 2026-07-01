/**
 * `trivial-diff` tier routing — the pure, IO-free predicate that decides which review
 * gate a PR takes (ADR
 * [0120](../../../../../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) §2–§3).
 *
 * The executor `.claude/workflows/drive-issue.js` classifies a PR's diff with the
 * trivial-diff classifier (`command.ts` → `trivial-diff.ts`) and then routes the Review
 * phase: a `trivial` verdict from an OK classifier takes the **lighter** `review-trivial`
 * gate; everything else takes the **full** `review-code` / `review-doc` / `review-skill`
 * fan-out. This file is the routing decision as a single tested unit, so the fail-closed
 * fallback has an explicit, verifiable contract instead of living only in workflow prose
 * (ADR 0120 §3). The workflow inlines the same one-line rule because a workflow script —
 * top-level `return`, injected globals — is not importable; this module is its canonical
 * mirror and the one that carries the unit test.
 *
 * **Default-deny (ADR 0120 §3).** The lighter path is selected ONLY on the positive
 * conjunction — the tier is enabled AND the classifier ran OK AND its verdict is exactly
 * `trivial`. ANY other state — the tier disabled (its default, pending #1560's
 * measurement authorization), a classifier error / unparseable output, a `non-trivial`
 * verdict, or an unrecognized verdict word — falls back to the FULL fan-out. A
 * misclassification can therefore only ever over-pay the full (correct) cost, never
 * under-gate a non-trivial change under the lighter gate.
 */

/** The two review lanes the executor can route a PR through. */
export type ReviewTier = "lighter" | "full";

/** Everything the routing decision needs from the (live) world, resolved by the executor. */
export interface RouteInput {
	/**
	 * Whether the trivial tier is switched on at all. It is **off by default** (ADR 0120
	 * §4 + ADR 0112): the branch is wired but a pure no-op until child #1560's two-axis
	 * measurement (a real token win AND held gate-accuracy, quality regression vetoing)
	 * authorizes the flip. Off ⇒ every PR takes the full fan-out exactly as before.
	 */
	readonly trivialTierEnabled: boolean;
	/**
	 * Whether the trivial-diff classifier was invoked and its stdout verdict parsed
	 * successfully. `false` on any failure to run or read the classifier — fail-closed to
	 * the full path (the classifier itself is fail-closed internally, and so is the wiring
	 * that consumes it).
	 */
	readonly classifierOk: boolean;
	/** The classifier's stdout verdict word — `trivial` / `non-trivial` (or anything else). */
	readonly verdict: string;
}

/**
 * Decide the review tier for a PR — default-deny (ADR 0120 §3). Returns `"lighter"` ONLY
 * on the full positive conjunction; every other input resolves to `"full"`.
 */
export const selectReviewTier = (input: RouteInput): ReviewTier =>
	input.trivialTierEnabled && input.classifierOk && input.verdict === "trivial"
		? "lighter"
		: "full";
