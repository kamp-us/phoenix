/**
 * The moderation-queue enrichment merge (#1702) — the pure decision layer that
 * folds each open-report group together with its reported target's context
 * (excerpt/title, author, in-situ routing ref). The batched content reads live in
 * the `Moderate`-gated `report.listOpen` resolver (`lists.ts`, dispatching to the
 * owning content service per `targetKind`); this module is engine-free so the
 * merge — which context lands on which group, and the missing-context fallback — is
 * a T1 unit (`*.unit.test.ts` precedent).
 */
import type {TargetKind} from "../../db/target-kind.ts";
import type {OpenReportGroup} from "./Report.ts";
import {type RowReputation, rowReputationOf} from "./reputation.ts";
import {toOpenReport} from "./shapers.ts";
import type {OpenReport} from "./views.ts";

/**
 * The reported target's in-situ context: a content excerpt/title, the author handle,
 * and the routing reference the client links from (post id for post & comment→parent
 * post, term slug for definition). Kind-neutral so the queue row renders context
 * without re-branching per `targetKind`.
 */
export interface ReportTargetContext {
	excerpt: string;
	author: string;
	/** post id (post, comment→parent post) or term slug (definition). */
	ref: string;
	/**
	 * The target author's account id — the join key for the #1703 reputation cluster
	 * (künye tier/karma + prior-removals). Carried off the same batched content read
	 * that resolves the excerpt/author, so the row's author standing joins from this id
	 * without a second target lookup.
	 */
	authorId: string;
}

/** The `<kind>:<id>` key an `OpenReport`/context map is keyed by (matches the view `id`). */
export const contextKeyOf = (targetKind: TargetKind, targetId: string): string =>
	`${targetKind}:${targetId}`;

/**
 * Clamp a body to a single-line queue excerpt: collapse whitespace and cut to
 * `max` graphemes-ish (code units suffice for the ASCII/Turkish copy), appending an
 * ellipsis when truncated. An already-short title/body passes through untouched.
 */
export const toExcerpt = (text: string, max = 140): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max).trimEnd()}…`;
};

/**
 * Fold each report group with its resolved target context AND its reputation cluster
 * (both keyed by `<kind>:<id>`), producing the enriched `OpenReport` rows the resolver
 * returns. A group with no matching context — an unresolved/hidden target — keeps null
 * context fields rather than being dropped, so the queue never loses a row to a missing
 * excerpt; the reputation cluster's author fields are likewise null when the author is
 * unresolved (`rowReputationOf`), while `distinctReporters` always resolves (it falls
 * back to the group's report count).
 */
export const enrichOpenReports = (
	groups: ReadonlyArray<OpenReportGroup>,
	contexts: ReadonlyMap<string, ReportTargetContext>,
	reputations: ReadonlyMap<string, RowReputation>,
): OpenReport[] =>
	groups.map((g) => {
		const key = contextKeyOf(g.targetKind, g.targetId);
		return toOpenReport(
			g,
			contexts.get(key),
			reputations.get(key) ?? rowReputationOf(g, undefined, undefined),
		);
	});
