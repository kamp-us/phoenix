/**
 * Report wire-entity shaper. `ReportReceipt` is returned inline by the
 * `report.submit` mutation (no re-resolution through a source), so the interpreter
 * never stamps `__typename` for it — the handler must. This is the one and only
 * spelling of the `{__typename, …}` literal, so the receipt carries the same
 * discriminant every other fate entity does and the client can normalize it by
 * `__typename` (`.patterns/fate-effect-operations.md`).
 */

import {type TargetKind, targetKey} from "../../db/target-kind.ts";
import type {ReportTargetContext} from "./enrich.ts";
import type {OpenReportGroup, ReportResult, ResolvedReportGroup} from "./Report.ts";
import type {RowReputation} from "./reputation.ts";
import type {Resolution} from "./resolution.ts";
import type {OpenReport, ReportReceipt, ResolvedReport, ResolveReceipt} from "./views.ts";

// `id` is the `<targetKind>:<targetId>` normalization key (see `views.ts`).
export const toReportReceipt = (r: ReportResult): ReportReceipt => ({
	__typename: "ReportReceipt",
	id: targetKey(r.targetKind, r.targetId),
	targetKind: r.targetKind,
	targetId: r.targetId,
	created: r.created,
});

// `context` is the reported target's in-situ enrichment (#1702), resolved in the
// `Moderate`-gated `report.listOpen` path; absent (`undefined`) for a target whose
// content couldn't be read, in which case the `target*` fields are null. `reputation`
// is the #1703 künye-join cluster (author standing + reporter diversity); it always
// carries a `distinctReporters` (falling back to the group's report count upstream)
// and null author fields when the author is unresolved.
export const toOpenReport = (
	g: OpenReportGroup,
	context: ReportTargetContext | undefined,
	reputation: RowReputation,
): OpenReport => ({
	__typename: "OpenReport",
	id: targetKey(g.targetKind, g.targetId),
	targetKind: g.targetKind,
	targetId: g.targetId,
	reportCount: g.reportCount,
	reason: g.reason,
	firstReportedAt: g.firstReportedAt.toISOString(),
	targetExcerpt: context?.excerpt ?? null,
	targetAuthor: context?.author ?? null,
	targetRef: context?.ref ?? null,
	authorId: reputation.authorId,
	distinctReporters: reputation.distinctReporters,
	authorTier: reputation.authorTier,
	authorKarma: reputation.authorKarma,
	authorPriorRemovals: reputation.authorPriorRemovals,
	authorDefinitionCount: reputation.authorDefinitionCount,
	authorPostCount: reputation.authorPostCount,
	authorCommentCount: reputation.authorCommentCount,
	authorKefil: reputation.authorKefil,
	authorReportedTargets: reputation.authorReportedTargets,
});

// `context` is the decided target's in-situ enrichment, resolved in the
// `Moderate`-gated `report.listResolved` path; absent (`undefined`) for a target whose
// content couldn't be read (removed/sandboxed), in which case the `target*` fields are
// null. `resolverHandle` is the resolver's display handle joined from the same gated
// read; null when the identity couldn't be resolved.
export const toResolvedReport = (
	g: ResolvedReportGroup,
	context: ReportTargetContext | undefined,
	resolverHandle: string | null,
): ResolvedReport => ({
	__typename: "ResolvedReport",
	id: targetKey(g.targetKind, g.targetId),
	targetKind: g.targetKind,
	targetId: g.targetId,
	resolution: g.resolution,
	resolverId: g.resolverId,
	resolverHandle,
	resolvedAt: g.resolvedAt.toISOString(),
	reportCount: g.reportCount,
	waveId: g.waveId,
	targetExcerpt: context?.excerpt ?? null,
	targetAuthor: context?.author ?? null,
	targetRef: context?.ref ?? null,
});

export const toResolveReceipt = (r: {
	targetKind: TargetKind;
	targetId: string;
	resolution: Resolution;
	targetRemoved: boolean;
	collapsed: number;
}): ResolveReceipt => ({
	__typename: "ResolveReceipt",
	id: targetKey(r.targetKind, r.targetId),
	targetKind: r.targetKind,
	targetId: r.targetId,
	resolution: r.resolution,
	targetRemoved: r.targetRemoved,
	collapsed: r.collapsed,
});
