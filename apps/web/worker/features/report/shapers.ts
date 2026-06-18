/**
 * Report wire-entity shaper. `ReportReceipt` is returned inline by the
 * `report.submit` mutation (no re-resolution through a source), so the interpreter
 * never stamps `__typename` for it — the handler must. This is the one and only
 * spelling of the `{__typename, …}` literal, so the receipt carries the same
 * discriminant every other fate entity does and the client can normalize it by
 * `__typename` (`.patterns/fate-effect-operations.md`).
 */

import type {ReportResult} from "./Report.ts";
import type {ReportReceipt} from "./views.ts";

// `id` is the `<targetKind>:<targetId>` normalization key (see `views.ts`).
export const toReportReceipt = (r: ReportResult): ReportReceipt => ({
	__typename: "ReportReceipt",
	id: `${r.targetKind}:${r.targetId}`,
	targetKind: r.targetKind,
	targetId: r.targetId,
	created: r.created,
});
