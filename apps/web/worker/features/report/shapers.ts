/**
 * Report wire-entity shaper. `ReportReceipt` is returned inline by the
 * `report.submit` mutation (no re-resolution through a source), so the interpreter
 * never stamps `__typename` for it — the handler must. This is the one and only
 * spelling of the `{__typename, …}` literal, so the receipt carries the same
 * discriminant every other fate entity does and the client can normalize it by
 * `__typename` (`.patterns/fate-effect-operations.md`).
 */

import type {TargetKind} from "../../db/target-kind.ts";
import type {ReportTargetContext} from "./enrich.ts";
import type {OpenReportGroup, ReportResult} from "./Report.ts";
import type {Resolution} from "./resolution.ts";
import type {OpenReport, ReportReceipt, ResolveReceipt} from "./views.ts";

// `id` is the `<targetKind>:<targetId>` normalization key (see `views.ts`).
export const toReportReceipt = (r: ReportResult): ReportReceipt => ({
	__typename: "ReportReceipt",
	id: `${r.targetKind}:${r.targetId}`,
	targetKind: r.targetKind,
	targetId: r.targetId,
	created: r.created,
});

// `context` is the reported target's in-situ enrichment (#1702), resolved in the
// `Moderate`-gated `report.listOpen` path; absent (`undefined`) for a target whose
// content couldn't be read, in which case the `target*` fields are null.
export const toOpenReport = (g: OpenReportGroup, context?: ReportTargetContext): OpenReport => ({
	__typename: "OpenReport",
	id: `${g.targetKind}:${g.targetId}`,
	targetKind: g.targetKind,
	targetId: g.targetId,
	reportCount: g.reportCount,
	reason: g.reason,
	firstReportedAt: g.firstReportedAt.toISOString(),
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
	id: `${r.targetKind}:${r.targetId}`,
	targetKind: r.targetKind,
	targetId: r.targetId,
	resolution: r.resolution,
	targetRemoved: r.targetRemoved,
	collapsed: r.collapsed,
});
