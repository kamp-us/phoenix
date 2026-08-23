/**
 * fate data views — the SPA's one stable type-import surface. See
 * `.patterns/fate-data-views.md`, `.patterns/per-feature-fate-aggregators.md`.
 */

import type {AssertFieldMapResolved} from "@kampus/fate-effect";
// Every View class is imported type-only so the field-map guard at the bottom of this
// file can assert over the full shipping surface.
import type {AdminProbeView} from "../admin-console/probe-view.ts";
import type {
	NotificationChannelView,
	NotificationMarkReceiptView,
	NotificationUnreadView,
	NotificationView,
} from "../bildirim/views.ts";
import type {CaylakVisibilityPreferenceView} from "../caylak-visibility/views.ts";
import type {
	DivanBacklogItemView,
	DivanCaylakView,
	DivanPendingView,
	DivanVoteReceiptView,
} from "../divan/views.ts";
import type {FunnelSummaryView} from "../funnel/views.ts";
import type {MecmuaPostView, MecmuaSubscriptionReceiptView} from "../mecmua/views.ts";
import type {MutedMemberView, MuteReceiptView} from "../mute/views.ts";
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
	RoleStateView,
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
import type {UserAdminView} from "../user-admin/views.ts";
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
export type {CaylakVisibilityPreference} from "../caylak-visibility/views.ts";
export {caylakVisibilityPreferenceDataView} from "../caylak-visibility/views.ts";
export type {
	DivanBacklogItem,
	DivanCaylak,
	DivanPending,
	DivanVoteReceipt,
} from "../divan/views.ts";
export {
	divanBacklogItemDataView,
	divanCaylakDataView,
	divanPendingDataView,
	divanVoteReceiptDataView,
} from "../divan/views.ts";
export type {FunnelSummary} from "../funnel/views.ts";
export {funnelSummaryDataView} from "../funnel/views.ts";
export type {MecmuaPost, MecmuaSubscriptionReceipt} from "../mecmua/views.ts";
export {mecmuaPostDataView, mecmuaSubscriptionReceiptDataView} from "../mecmua/views.ts";
export type {MutedMember, MuteReceipt} from "../mute/views.ts";
export {mutedMemberDataView, muteReceiptDataView} from "../mute/views.ts";
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
	RoleStateEntity as RoleState,
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
	roleStateDataView,
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
export type {UserAdminEntity as UserAdmin, UserAdminRole} from "../user-admin/views.ts";
export {userAdminDataView} from "../user-admin/views.ts";

/**
 * The client-exposed root map the fate Vite plugin turns into typed client roots at
 * build time. Only custom-resolver roots appear — byId roots are generated from the
 * source registry.
 *
 * Annotated `Record<string, unknown>` to stay nameable: a precise type would surface
 * fate's internal `DataView` symbol (TS2883/TS4023). The plugin only inspects this
 * value at runtime.
 */
export const Root: Record<string, unknown> = mergeFateRoots(modules);

// The loud-fail field-map guard. `AssertFieldMapResolved` resolves to the view itself
// while fate's `dataViewFieldsKey` symbol recovery is healthy, or to a named
// `FieldMapRecoveryFailed<Name>` brand when the symbol identity slips. The
// `Guarded extends Resolved` slot turns that brand into a NAMED compile error here,
// instead of a silent `never` at a far-away `view<>()` selection (#2805).
//
// Must NOT be exported: surfacing fate's internal `DataView` types on this composite
// project's declaration boundary trips the TS2883/TS4020 nameability checks.
type AssertResolved<Resolved, Guarded extends Resolved> = Guarded;

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
	AssertResolved<
		typeof CaylakVisibilityPreferenceView,
		AssertFieldMapResolved<typeof CaylakVisibilityPreferenceView>
	>,
	AssertResolved<typeof DivanCaylakView, AssertFieldMapResolved<typeof DivanCaylakView>>,
	AssertResolved<typeof DivanBacklogItemView, AssertFieldMapResolved<typeof DivanBacklogItemView>>,
	AssertResolved<typeof DivanPendingView, AssertFieldMapResolved<typeof DivanPendingView>>,
	AssertResolved<typeof DivanVoteReceiptView, AssertFieldMapResolved<typeof DivanVoteReceiptView>>,
	AssertResolved<typeof FunnelSummaryView, AssertFieldMapResolved<typeof FunnelSummaryView>>,
	AssertResolved<typeof MecmuaPostView, AssertFieldMapResolved<typeof MecmuaPostView>>,
	AssertResolved<
		typeof MecmuaSubscriptionReceiptView,
		AssertFieldMapResolved<typeof MecmuaSubscriptionReceiptView>
	>,
	AssertResolved<typeof MuteReceiptView, AssertFieldMapResolved<typeof MuteReceiptView>>,
	AssertResolved<typeof MutedMemberView, AssertFieldMapResolved<typeof MutedMemberView>>,
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
	AssertResolved<typeof RoleStateView, AssertFieldMapResolved<typeof RoleStateView>>,
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
	AssertResolved<typeof UserAdminView, AssertFieldMapResolved<typeof UserAdminView>>,
];
