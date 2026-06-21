/**
 * Report wire-entity shaper. `ReportReceipt` is returned inline by the
 * `report.submit` mutation (no re-resolution through a source), so the interpreter
 * never stamps `__typename` for it — the handler must. This is the one and only
 * spelling of the `{__typename, …}` literal, so the receipt carries the same
 * discriminant every other fate entity does and the client can normalize it by
 * `__typename` (`.patterns/fate-effect-operations.md`).
 */

import type {ReportTargetKind} from "./errors.ts";
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

export const toOpenReport = (g: OpenReportGroup): OpenReport => ({
	__typename: "OpenReport",
	id: `${g.targetKind}:${g.targetId}`,
	targetKind: g.targetKind,
	targetId: g.targetId,
	reportCount: g.reportCount,
	reason: g.reason,
	firstReportedAt: g.firstReportedAt.toISOString(),
});

export const toResolveReceipt = (r: {
	targetKind: ReportTargetKind;
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
