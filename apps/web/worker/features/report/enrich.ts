/**
 * The pure moderation-queue enrichment merge: fold each report group with its target's
 * context. Engine-free on purpose — the batched content reads live in the `Moderate`-gated
 * `report.listOpen` resolver, so the merge stays a unit test.
 */
import {type TargetKind, targetKey} from "../../db/target-kind.ts";
import type {OpenReportGroup, ResolvedReportGroup} from "./Report.ts";
import {type RowReputation, rowReputationOf} from "./reputation.ts";
import {toOpenReport, toResolvedReport} from "./shapers.ts";
import type {OpenReport, ResolvedReport} from "./views.ts";

export interface ReportTargetContext {
	excerpt: string;
	author: string;
	/** post id (post, comment→parent post) or term slug (definition). */
	ref: string;
	// The join key for the reputation cluster, carried off the same batched content read that
	// resolves the excerpt/author, so author standing joins without a second target lookup.
	authorId: string;
}

export const contextKeyOf = (targetKind: TargetKind, targetId: string): string =>
	targetKey(targetKind, targetId);

export const toExcerpt = (text: string, max = 140): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max).trimEnd()}…`;
};

// A group with no matching context — an unresolved/hidden target — keeps null context
// fields rather than being dropped, so the queue never loses a row. `distinctReporters`
// always resolves: it falls back to the group's report count.
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

// A group with no matching context — a removed/hidden target — keeps null context fields
// rather than being dropped, so the feed never loses a decision to a missing excerpt; an
// unresolved resolver handle folds to null.
export const enrichResolvedReports = (
	groups: ReadonlyArray<ResolvedReportGroup>,
	contexts: ReadonlyMap<string, ReportTargetContext>,
	resolverHandles: ReadonlyMap<string, string | null>,
): ResolvedReport[] =>
	groups.map((g) =>
		toResolvedReport(
			g,
			contexts.get(contextKeyOf(g.targetKind, g.targetId)),
			resolverHandles.get(g.resolverId) ?? null,
		),
	);
