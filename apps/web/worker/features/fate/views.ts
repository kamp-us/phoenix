/**
 * fate data views — the SPA's one stable type-import surface: a barrel
 * re-exporting every feature's entity types + view consts. The cross-feature
 * client-exposed `Root` is no longer hand-listed here — it derives from the same
 * `config.ts` feature registry that drives the served config, so a feature's roots
 * are named once (on its `fate-module.ts`), not twice (barrel + `Root`). See
 * `.patterns/fate-data-views.md`, `.patterns/per-feature-fate-aggregators.md`.
 */

import type {AssertFieldMapResolved} from "@kampus/fate-effect";
// Every client-facing entity's View class, imported (type-only) so the loud-fail
// field-map guard can be asserted over the full shipping surface at the bottom of
// this file. See the `AssertFieldMapResolved` block below (#2808/#2811).
import type {AdminProbeView} from "../admin-console/probe-view.ts";
import type {
	NotificationChannelView,
	NotificationMarkReceiptView,
	NotificationUnreadView,
	NotificationView,
} from "../bildirim/views.ts";
import type {DivanBacklogItemView, DivanCaylakView, DivanVoteReceiptView} from "../divan/views.ts";
import type {FunnelSummaryView} from "../funnel/views.ts";
import type {MecmuaPostView, MecmuaSubscriptionReceiptView} from "../mecmua/views.ts";
import type {MuteReceiptView} from "../mute/views.ts";
import type {CommentView, PostOverlayView, PostView, TagView} from "../pano/views.ts";
import type {
	AccountDeletionReceiptView,
	AuthorshipStandingView,
	BanStateView,
	ContributionView,
	EmailDeliveryStateView,
	FailingAddressView,
	ProfileView,
	PromotionReceiptView,
	UserView,
} from "../pasaport/views.ts";
import type {
	OpenReportView,
	ReportReceiptView,
	ResolvedReportView,
	ResolveReceiptView,
} from "../report/views.ts";
import type {DefinitionView, TermView} from "../sozluk/views.ts";
import type {LandingStatsView} from "../stats/views.ts";
import {modules} from "./config.ts";
import {mergeFateRoots} from "./module.ts";

export type {AdminProbe} from "../admin-console/probe-view.ts";
export {adminProbeDataView} from "../admin-console/probe-view.ts";
export type {
	Notification,
	NotificationChannel,
	NotificationMarkReceipt,
	NotificationUnread,
} from "../bildirim/views.ts";
export {
	notificationChannelDataView,
	notificationDataView,
	notificationMarkReceiptDataView,
	notificationUnreadDataView,
} from "../bildirim/views.ts";
export type {DivanBacklogItem, DivanCaylak, DivanVoteReceipt} from "../divan/views.ts";
export {
	divanBacklogItemDataView,
	divanCaylakDataView,
	divanVoteReceiptDataView,
} from "../divan/views.ts";
export type {FunnelSummary} from "../funnel/views.ts";
export {funnelSummaryDataView} from "../funnel/views.ts";
export type {MecmuaPost, MecmuaSubscriptionReceipt} from "../mecmua/views.ts";
export {mecmuaPostDataView, mecmuaSubscriptionReceiptDataView} from "../mecmua/views.ts";
export type {MuteReceipt} from "../mute/views.ts";
export {muteReceiptDataView} from "../mute/views.ts";
export type {Comment, Post, PostOverlay, Tag} from "../pano/views.ts";
export {
	commentDataView,
	postDataView,
	postOverlayDataView,
	tagDataView,
} from "../pano/views.ts";
export type {
	AccountDeletionReceipt,
	AuthorshipStanding,
	BanStateEntity as BanState,
	Contribution,
	EmailDeliveryStateEntity as EmailDeliveryState,
	FailingAddressEntity as FailingAddress,
	Profile,
	PromotionReceipt,
	User,
} from "../pasaport/views.ts";
export {
	accountDeletionReceiptDataView,
	authorshipStandingDataView,
	banStateDataView,
	contributionDataView,
	emailDeliveryStateDataView,
	failingAddressDataView,
	profileDataView,
	promotionReceiptDataView,
	userDataView,
} from "../pasaport/views.ts";
export type {
	OpenReport,
	ReportReceipt,
	ResolvedReport,
	ResolveReceipt,
} from "../report/views.ts";
export {
	openReportDataView,
	reportReceiptDataView,
	resolvedReportDataView,
	resolveReceiptDataView,
} from "../report/views.ts";
export type {Definition, Term} from "../sozluk/views.ts";
export {definitionDataView, termDataView} from "../sozluk/views.ts";
export type {LandingStats} from "../stats/views.ts";
export {landingStatsDataView} from "../stats/views.ts";

/**
 * The client-exposed root map the fate Vite plugin turns into typed client roots
 * at build time (`createSchema(views, Root)`); a `list(...)`-wrapped entry is a
 * `list` root, a bare view is a `query` root. Each feature owns its slice on its
 * `fate-module.ts` `roots`, and this merges them off the `config.ts` registry — so
 * a root's custom name + load-bearing constraints (the request-key→root-name
 * mapping, the reused Term/Post search views) live next to the feature's views.
 * Only custom-resolver roots appear — byId roots are generated from the source
 * registry, and `Root` is not passed to `createFateServer` (`roots` stays empty
 * there; `mergeFateModules` does not thread it).
 *
 * Annotated `Record<string, unknown>` to stay nameable: a precise type would
 * surface fate's internal `DataView` symbol (TS2883/TS4023); the plugin only
 * inspects this value at runtime.
 */
export const Root: Record<string, unknown> = mergeFateRoots(modules);

// --- Loud-fail field-map guard, adopted onto every shipping entity (#2808/#2811) ---
//
// `AssertFieldMapResolved<typeof XView>` (the #2810 machinery) resolves to the view
// itself when fate's `dataViewFieldsKey` symbol recovery is healthy, or to the named
// `FieldMapRecoveryFailed<Name>` brand when the symbol identity slips and the field map
// degrades to the wide `Record<string, DataField>` fallback (the #2805 failure). The
// `Guarded extends Resolved` slot below makes that brand a NAMED compile error HERE, at
// the barrel next to the entity — instead of a silent `never` at a far-away `view<>()`
// selection, which is exactly the silent degrade that cost the #2805 investigation cycle.
//
// This is intentionally NOT exported: surfacing fate's internal `DataView` types on this
// composite worker project's declaration boundary would trip the TS2883/TS4020 nameability
// checks (the same portability cost that keeps `Root` above annotated `Record<string,
// unknown>`). Kept local, the assertions type-check without emitting any declaration.
type AssertResolved<Resolved, Guarded extends Resolved> = Guarded;

// One entry per client-exposed entity; a slip on any one fails this list loudly.
type _FateViewsFieldMapResolved = [
	AssertResolved<typeof AdminProbeView, AssertFieldMapResolved<typeof AdminProbeView>>,
	AssertResolved<typeof NotificationView, AssertFieldMapResolved<typeof NotificationView>>,
	AssertResolved<
		typeof NotificationUnreadView,
		AssertFieldMapResolved<typeof NotificationUnreadView>
	>,
	AssertResolved<
		typeof NotificationChannelView,
		AssertFieldMapResolved<typeof NotificationChannelView>
	>,
	AssertResolved<
		typeof NotificationMarkReceiptView,
		AssertFieldMapResolved<typeof NotificationMarkReceiptView>
	>,
	AssertResolved<typeof DivanCaylakView, AssertFieldMapResolved<typeof DivanCaylakView>>,
	AssertResolved<typeof DivanBacklogItemView, AssertFieldMapResolved<typeof DivanBacklogItemView>>,
	AssertResolved<typeof DivanVoteReceiptView, AssertFieldMapResolved<typeof DivanVoteReceiptView>>,
	AssertResolved<typeof FunnelSummaryView, AssertFieldMapResolved<typeof FunnelSummaryView>>,
	AssertResolved<typeof MecmuaPostView, AssertFieldMapResolved<typeof MecmuaPostView>>,
	AssertResolved<
		typeof MecmuaSubscriptionReceiptView,
		AssertFieldMapResolved<typeof MecmuaSubscriptionReceiptView>
	>,
	AssertResolved<typeof MuteReceiptView, AssertFieldMapResolved<typeof MuteReceiptView>>,
	AssertResolved<typeof TagView, AssertFieldMapResolved<typeof TagView>>,
	AssertResolved<typeof CommentView, AssertFieldMapResolved<typeof CommentView>>,
	AssertResolved<typeof PostView, AssertFieldMapResolved<typeof PostView>>,
	AssertResolved<typeof PostOverlayView, AssertFieldMapResolved<typeof PostOverlayView>>,
	AssertResolved<typeof UserView, AssertFieldMapResolved<typeof UserView>>,
	AssertResolved<typeof ContributionView, AssertFieldMapResolved<typeof ContributionView>>,
	AssertResolved<typeof ProfileView, AssertFieldMapResolved<typeof ProfileView>>,
	AssertResolved<
		typeof AccountDeletionReceiptView,
		AssertFieldMapResolved<typeof AccountDeletionReceiptView>
	>,
	AssertResolved<typeof PromotionReceiptView, AssertFieldMapResolved<typeof PromotionReceiptView>>,
	AssertResolved<typeof BanStateView, AssertFieldMapResolved<typeof BanStateView>>,
	AssertResolved<
		typeof EmailDeliveryStateView,
		AssertFieldMapResolved<typeof EmailDeliveryStateView>
	>,
	AssertResolved<typeof FailingAddressView, AssertFieldMapResolved<typeof FailingAddressView>>,
	AssertResolved<
		typeof AuthorshipStandingView,
		AssertFieldMapResolved<typeof AuthorshipStandingView>
	>,
	AssertResolved<typeof OpenReportView, AssertFieldMapResolved<typeof OpenReportView>>,
	AssertResolved<typeof ReportReceiptView, AssertFieldMapResolved<typeof ReportReceiptView>>,
	AssertResolved<typeof ResolvedReportView, AssertFieldMapResolved<typeof ResolvedReportView>>,
	AssertResolved<typeof ResolveReceiptView, AssertFieldMapResolved<typeof ResolveReceiptView>>,
	AssertResolved<typeof DefinitionView, AssertFieldMapResolved<typeof DefinitionView>>,
	AssertResolved<typeof TermView, AssertFieldMapResolved<typeof TermView>>,
	AssertResolved<typeof LandingStatsView, AssertFieldMapResolved<typeof LandingStatsView>>,
];
