/**
 * `ReportReceipt` is returned inline by `report.submit`, so the interpreter never stamps
 * `__typename` for it — the handler must. This is the one and only spelling of that
 * literal (`.patterns/fate-effect-operations.md`).
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

// `context` is absent for a target whose content couldn't be read, in which case the
// `target*` fields are null (#1702).
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

// As above: `context` is absent when the target's content couldn't be read
// (removed/sandboxed), and the `target*` fields are then null.
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
