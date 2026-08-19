/**
 * The `report.submit` ack — NOT a re-resolved entity: a report is private moderation
 * state with no public read view (ADR 0082). Result-only, no source/fetch path; see
 * `.patterns/fate-effect-data-views.md`. `id` is the stable `<targetKind>:<targetId>` key.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {TargetKind} from "../../db/target-kind.ts";
import type {ViewRow} from "../fate/view-types.ts";
import type {Resolution} from "./resolution.ts";

export type ReportReceiptViewRow = ViewRow<{
	id: string;
	targetKind: TargetKind;
	targetId: string;
	created: boolean;
}>;

export class ReportReceiptView extends FateDataView<ReportReceiptViewRow>()("ReportReceipt")({
	id: true,
	targetKind: true,
	targetId: true,
	created: true,
} satisfies {[K in keyof ReportReceiptViewRow]: true}) {}

export const reportReceiptDataView = ReportReceiptView.view;

export type ReportReceipt = WorkerEntity<typeof ReportReceiptView>;

/**
 * One moderation-queue entry (ADR 0098 §5). Every `target*` and `author*` field is
 * enriched INSIDE the `Moderate`-gated `report.listOpen` read — never a second, public
 * data path. All are nullable, and the `author*` cluster nulls together (never a partial
 * reputation); a target whose context won't resolve renders bare rather than blocking
 * the queue. `id` is `<targetKind>:<targetId>`.
 */
export type OpenReportViewRow = ViewRow<{
	id: string;
	targetKind: TargetKind;
	targetId: string;
	reportCount: number;
	reason: string | null;
	firstReportedAt: string;
	targetExcerpt: string | null;
	targetAuthor: string | null;
	/** Post id (post & comment→parent post) or term slug (definition). */
	targetRef: string | null;
	authorId: string | null;
	distinctReporters: number;
	authorTier: string | null;
	authorKarma: number | null;
	/** How many of the author's targets a moderator previously removed. */
	authorPriorRemovals: number | null;
	authorDefinitionCount: number | null;
	authorPostCount: number | null;
	authorCommentCount: number | null;
	/** `true` when someone actively vouches for the author. */
	authorKefil: boolean | null;
	/** How many DISTINCT targets of this author are open-reported (the "bu aktör" count). */
	authorReportedTargets: number | null;
}>;

export class OpenReportView extends FateDataView<OpenReportViewRow>()("OpenReport")({
	id: true,
	targetKind: true,
	targetId: true,
	reportCount: true,
	reason: true,
	firstReportedAt: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
	authorId: true,
	distinctReporters: true,
	authorTier: true,
	authorKarma: true,
	authorPriorRemovals: true,
	authorDefinitionCount: true,
	authorPostCount: true,
	authorCommentCount: true,
	authorKefil: true,
	authorReportedTargets: true,
} satisfies {[K in keyof OpenReportViewRow]: true}) {}

export const openReportDataView = OpenReportView.view;

export type OpenReport = WorkerEntity<typeof OpenReportView>;

export type ResolveReceiptViewRow = ViewRow<{
	id: string;
	targetKind: TargetKind;
	targetId: string;
	resolution: Resolution;
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
} satisfies {[K in keyof ResolveReceiptViewRow]: true}) {}

export const resolveReceiptDataView = ResolveReceiptView.view;

export type ResolveReceipt = WorkerEntity<typeof ResolveReceiptView>;

/**
 * One entry of the shared decision feed (#1704). `Moderate`-gated like `OpenReport`, with
 * its `target*` context enriched inside that same read; every nullable field renders bare
 * rather than dropping the row. `id` is `<targetKind>:<targetId>`.
 */
export type ResolvedReportViewRow = ViewRow<{
	id: string;
	targetKind: TargetKind;
	targetId: string;
	/** `removed` (content soft-deleted) | `dismissed` (report unfounded). */
	resolution: Resolution;
	resolverId: string;
	resolverHandle: string | null;
	/** ISO-8601. */
	resolvedAt: string;
	/** How many reports the decision collapsed on this target. */
	reportCount: number;
	/**
	 * Shared across a wave batch's targets (#1855), `null` on a lone removal. Rows sharing
	 * one render as a single entry whose restore reopens the whole batch.
	 */
	waveId: string | null;
	targetExcerpt: string | null;
	targetAuthor: string | null;
	/** Post id (post & comment→parent post) or term slug (definition). */
	targetRef: string | null;
}>;

export class ResolvedReportView extends FateDataView<ResolvedReportViewRow>()("ResolvedReport")({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	resolverId: true,
	resolverHandle: true,
	resolvedAt: true,
	reportCount: true,
	waveId: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
} satisfies {[K in keyof ResolvedReportViewRow]: true}) {}

export const resolvedReportDataView = ResolvedReportView.view;

export type ResolvedReport = WorkerEntity<typeof ResolvedReportView>;
