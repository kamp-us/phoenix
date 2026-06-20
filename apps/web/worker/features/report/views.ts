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

/**
 * `OpenReport` — one moderation-queue entry (ADR 0098 §5): an open-reported target
 * with its distinct-reporter (repeat-offender) count. Private moderation state, so
 * the `report.listOpen` root list is gated behind `Moderator.required`; no source
 * fetch path (the list resolver returns it inline). `id` is `<targetKind>:<targetId>`.
 */
export type OpenReportViewRow = ViewRow<{
	id: string;
	targetKind: ReportTargetKind;
	targetId: string;
	reportCount: number;
	reason: string | null;
	firstReportedAt: string;
}>;

export class OpenReportView extends FateDataView<OpenReportViewRow>()("OpenReport")({
	id: true,
	targetKind: true,
	targetId: true,
	reportCount: true,
	reason: true,
	firstReportedAt: true,
}) {}

export const openReportDataView = OpenReportView.view;

export type OpenReport = Entity<typeof OpenReportView>;

/**
 * `ResolveReceipt` — the `report.resolve` acknowledgement (ADR 0098 §3): the
 * decided `resolution`, whether the target was removed, and how many open reports
 * the resolve collapsed. Result-only view, like `ReportReceipt`.
 */
export type ResolveReceiptViewRow = ViewRow<{
	id: string;
	targetKind: ReportTargetKind;
	targetId: string;
	resolution: "removed" | "dismissed";
	targetRemoved: boolean;
	collapsed: number;
}>;

export class ResolveReceiptView extends FateDataView<ResolveReceiptViewRow>()("ResolveReceipt")({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	targetRemoved: true,
	collapsed: true,
}) {}

export const resolveReceiptDataView = ResolveReceiptView.view;

export type ResolveReceipt = Entity<typeof ResolveReceiptView>;
