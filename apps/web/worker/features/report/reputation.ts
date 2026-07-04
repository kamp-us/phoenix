/**
 * The triage-loop's reputation-in-row merge (#1703, ADR 0138) — the pure decision
 * layer that folds each open-report group's reported-target author standing
 * (tier + karma + prior moderator-removals) and the pile-on's reporter-diversity
 * signal onto the enriched `OpenReport` row. This is the künye-join seam the actor
 * drawer (#1852) and the remove-the-wave slice (#1855) both dock into: the row
 * query joins künye NOW so the shape is modelled, not a later backend redo.
 *
 * Kept engine-free (the batched künye/removal reads live in the `Moderate`-gated
 * `report.listOpen` resolver, `lists.ts`), so the merge — which reputation lands on
 * which group, the missing-standing fallback, and the diversity ratio — is a T1
 * unit (`*.unit.test.ts` precedent), the same split `enrich.ts` follows.
 */
import {type TargetKind, targetKey} from "../../db/target-kind.ts";
import type {Tier} from "../kunye/standing.ts";
import type {OpenReportGroup} from "./Report.ts";

/**
 * The reported target's author standing, keyed by author id and resolved inside the
 * gated read. `null`-safe upstream: a target whose author can't be resolved (missing
 * context / anonymized) carries no reputation and the row renders the neutral
 * fallback rather than a fabricated tier.
 */
export interface AuthorReputation {
	/** The author's account id — the actor-drawer's cross-mode hop key (#1852). */
	authorId: string;
	tier: Tier;
	karma: number;
	/** How many of this author's targets a moderator has previously removed (0 = clean). */
	priorRemovals: number;
	/** The author's live content footprint (#1852): tanım / gönderi / yorum counts. */
	definitionCount: number;
	postCount: number;
	commentCount: number;
	/** Whether someone actively vouches (kefil) this author (#1852). */
	kefil: boolean;
	/** How many DISTINCT targets of this author are open-reported (the "bu aktör" count, #1852). */
	reportedTargets: number;
}

/**
 * The pile-on's reporter-diversity signal (ADR 0138): the total open reports on the
 * target and how many DISTINCT reporters filed them. `9 rapor · 7 farklı kişi` reads
 * as a real wave; `9 rapor · 1 kişi` reads as one grudge-reporter. Threaded now so
 * #1855's remove-the-wave has the contrast even though the composite report PK makes
 * `distinctReporters === reportCount` for content targets today.
 */
export interface ReporterDiversity {
	reportCount: number;
	distinctReporters: number;
}

/**
 * The reputation-enriched fields folded onto an `OpenReport` row. All author-standing
 * fields are nullable together — an unresolvable author leaves the whole cluster null
 * so the row never claims a partial (tier-without-karma) reputation.
 */
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

/** The `<kind>:<id>` key an author-reputation map is keyed by (mirrors the view `id`). */
export const reputationKeyOf = (targetKind: TargetKind, targetId: string): string =>
	targetKey(targetKind, targetId);

/**
 * Fold a group with its resolved author reputation + distinct-reporter count into the
 * row-reputation cluster. A group with no reputation (unresolved author) keeps every
 * author field null; `distinctReporters` falls back to the group's `reportCount` when
 * the diversity read didn't separate it (the PK-collapsed default), never below 1 for
 * a real reported target.
 */
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
