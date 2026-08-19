/**
 * The pure reputation-in-row merge (ADR 0138): fold each open-report group's target-author
 * standing and the pile-on's reporter-diversity signal onto the enriched `OpenReport` row.
 * Engine-free — the batched künye/removal reads live in the `Moderate`-gated resolver.
 */
import {type TargetKind, targetKey} from "../../db/target-kind.ts";
import type {Tier} from "../kunye/standing.ts";
import type {OpenReportGroup} from "./Report.ts";

// A target whose author cannot be resolved (missing context / anonymized) carries no
// reputation, and the row renders the neutral fallback rather than a fabricated tier.
export interface AuthorReputation {
	authorId: string;
	tier: Tier;
	karma: number;
	// How many of this author's targets a moderator has previously removed (0 = clean).
	priorRemovals: number;
	definitionCount: number;
	postCount: number;
	commentCount: number;
	kefil: boolean;
	reportedTargets: number;
}

// The pile-on's reporter-diversity signal (ADR 0138): `9 rapor · 7 farklı kişi` reads as a
// real wave, `9 rapor · 1 kişi` as one grudge-reporter. The composite report PK makes
// `distinctReporters === reportCount` for content targets today.
export interface ReporterDiversity {
	reportCount: number;
	distinctReporters: number;
}

// All author-standing fields are nullable together — an unresolvable author leaves the
// whole cluster null so the row never claims a partial (tier-without-karma) reputation.
export interface RowReputation {
	authorId: string | null;
	authorTier: Tier | null;
	authorKarma: number | null;
	authorPriorRemovals: number | null;
	distinctReporters: number;
	authorDefinitionCount: number | null;
	authorPostCount: number | null;
	authorCommentCount: number | null;
	authorKefil: boolean | null;
	authorReportedTargets: number | null;
}

export const reputationKeyOf = (targetKind: TargetKind, targetId: string): string =>
	targetKey(targetKind, targetId);

// A group with no reputation (unresolved author) keeps every author field null;
// `distinctReporters` falls back to the group's `reportCount` when the diversity read did
// not separate it.
export const rowReputationOf = (
	group: OpenReportGroup,
	reputation: AuthorReputation | undefined,
	diversity: ReporterDiversity | undefined,
): RowReputation => ({
	authorId: reputation?.authorId ?? null,
	authorTier: reputation?.tier ?? null,
	authorKarma: reputation?.karma ?? null,
	authorPriorRemovals: reputation?.priorRemovals ?? null,
	distinctReporters: diversity?.distinctReporters ?? group.reportCount,
	authorDefinitionCount: reputation?.definitionCount ?? null,
	authorPostCount: reputation?.postCount ?? null,
	authorCommentCount: reputation?.commentCount ?? null,
	authorKefil: reputation?.kefil ?? null,
	authorReportedTargets: reputation?.reportedTargets ?? null,
});
