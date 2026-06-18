/**
 * `ReportReceipt` — the `report.submit` acknowledgement, NOT a re-resolved
 * entity. A report is private moderation state with no public read view (ADR
 * 0082), so the mutation returns a small typed ack instead of a cached entity:
 * which target was reported and whether this call created a fresh row (`false`
 * on the idempotent re-report no-op). The synthetic `id` is the
 * `<targetKind>:<targetId>` key, stable per target so the client normalizes the
 * receipt to one record. Mirrors `LandingStats` — a result-only data view with
 * no source/fetch path. See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {ReportTargetKind} from "./errors.ts";

export type ReportReceiptViewRow = ViewRow<{
	id: string;
	targetKind: ReportTargetKind;
	targetId: string;
	created: boolean;
}>;

export class ReportReceiptView extends FateDataView<ReportReceiptViewRow>()("ReportReceipt")({
	id: true,
	targetKind: true,
	targetId: true,
	created: true,
}) {}

export const reportReceiptDataView = ReportReceiptView.view;

export type ReportReceipt = Entity<typeof ReportReceiptView>;
