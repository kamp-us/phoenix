/**
 * Pure SPA-side summary of an issue's gate verdict (#257) for the badge. Collapses
 * the per-namespace `{code, doc}` from a linked open PR into one glanceable state:
 *
 * - `null` verdict (no open PR linked) → no badge (`none`).
 * - an open PR with no marker in either namespace → `awaiting` (never a false verdict).
 * - any FAIL in either namespace → `fail` (a FAIL anywhere blocks the merge).
 * - otherwise (≥1 PASS, no FAIL) → `pass`.
 *
 * FAIL dominates PASS so a mixed code-PASS/doc-FAIL PR reads as not-merge-ready, which
 * is what `ship-it` enforces. Total over the wire shape; no React, unit-testable.
 */
import type {IssueVerdict} from "./pipeline.ts";

export type VerdictSummary = "pass" | "fail" | "awaiting" | "none";

export const summarizeVerdict = (verdict: IssueVerdict | null | undefined): VerdictSummary => {
	if (!verdict) return "none";
	if (verdict.code === "FAIL" || verdict.doc === "FAIL") return "fail";
	if (verdict.code === "PASS" || verdict.doc === "PASS") return "pass";
	return "awaiting";
};

/** The short human label for a summary; `none` has no label (renders nothing). */
export const verdictLabel = (summary: VerdictSummary): string | null => {
	switch (summary) {
		case "pass":
			return "PASS";
		case "fail":
			return "FAIL";
		case "awaiting":
			return "awaiting review";
		case "none":
			return null;
	}
};
