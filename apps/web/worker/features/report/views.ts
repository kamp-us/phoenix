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
 * `OpenReport` — one moderation-queue entry (ADR 0098 §5): an open-reported target
 * with its distinct-reporter (repeat-offender) count. Private moderation state, so
 * the `report.listOpen` root list is gated behind the `Moderate` capability (the
 * `moderates` relation tuple, ADR 0107 §4); no source
 * fetch path (the list resolver returns it inline). `id` is `<targetKind>:<targetId>`.
 *
 * The `target*` fields carry the reported target's in-situ context (#1702), enriched
 * inside the same `Moderate`-gated `report.listOpen` path (never a new public read):
 * a content excerpt/title, the author's handle, and the routing reference the client
 * turns into an in-situ link (post/comment → `/pano/<ref>`, definition →
 * `/sozluk/<ref>`). All three are nullable — a target whose context can't be resolved
 * (e.g. a sandboxed row hidden from the batched content read) renders the row without
 * context rather than blocking the queue.
 *
 * The `author*` reputation cluster + `distinctReporters` (#1703, ADR 0138) carry the
 * reported target author's standing (tier / karma / prior moderator-removals) and the
 * pile-on's reporter-diversity signal, joined from künye INSIDE this same gated read.
 * The author cluster is null together for an unresolvable author (never a partial
 * reputation); `distinctReporters` mirrors `reportCount` today (the composite report
 * PK collapses them for content targets) but is threaded as the seam #1852's actor
 * drawer and #1855's remove-the-wave dock into.
 *
 * The `authorId`, `authorProduction*` counts, `authorKefil`, and `authorReportedTargets`
 * (#1852, ADR 0138) complete the actor-drawer's join: the actor's account id (the
 * cross-mode hop key), their live content footprint (tanım / gönderi / yorum), their
 * kefil (vouch) status, and the "bu aktör" count of how many of their targets are
 * open-reported — all joined INSIDE this same gated read (a MODE over
 * `report.listOpen`, never a second data path). They are null together with the author
 * cluster when the author is unresolved.
 */
export type OpenReportViewRow = ViewRow<{
	id: string;
	targetKind: TargetKind;
	targetId: string;
	reportCount: number;
	reason: string | null;
	firstReportedAt: string;
	/** A content excerpt or title identifying the reported target (`null` when unresolved). */
	targetExcerpt: string | null;
	/** The reported target's author handle (`null` when unresolved). */
	targetAuthor: string | null;
	/** The in-situ routing reference: post id (post & comment→parent post) or term slug (definition). */
	targetRef: string | null;
	/** The reported target author's account id — the actor-drawer's cross-mode hop key (`null` when unresolved). */
	authorId: string | null;
	/** Distinct reporters filing open reports on this target (reporter-diversity numerator). */
	distinctReporters: number;
	/** The reported target author's authorship tier (`null` when the author is unresolved). */
	authorTier: string | null;
	/** The author's earned karma (`null` when unresolved). */
	authorKarma: number | null;
	/** How many of the author's targets a moderator previously removed (`null` when unresolved). */
	authorPriorRemovals: number | null;
	/** The author's live tanım (definition) production count (`null` when unresolved). */
	authorDefinitionCount: number | null;
	/** The author's live gönderi (post) production count (`null` when unresolved). */
	authorPostCount: number | null;
	/** The author's live yorum (comment) production count (`null` when unresolved). */
	authorCommentCount: number | null;
	/** The author's kefil (active-vouch) status — `true` when someone actively vouches them (`null` when unresolved). */
	authorKefil: boolean | null;
	/** How many DISTINCT targets of this author are open-reported (the "bu aktör" count; `null` when unresolved). */
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

/**
 * `ResolveReceipt` — the `report.resolve` acknowledgement (ADR 0098 §3): the
 * decided `resolution`, whether the target was removed, and how many open reports
 * the resolve collapsed. Result-only view, like `ReportReceipt`.
 */
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
