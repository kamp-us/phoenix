/**
 * fate data views — the SPA's one stable type-import surface: a barrel
 * re-exporting every feature's entity types + view consts. The cross-feature
 * client-exposed `Root` is no longer hand-listed here — it derives from the same
 * `config.ts` feature registry that drives the served config, so a feature's roots
 * are named once (on its `fate-module.ts`), not twice (barrel + `Root`). See
 * `.patterns/fate-data-views.md`, `.patterns/per-feature-fate-aggregators.md`.
 */

import {modules} from "./config.ts";
import {mergeFateRoots} from "./module.ts";

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
export type {Comment, Post, Tag} from "../pano/views.ts";
export {commentDataView, postDataView, tagDataView} from "../pano/views.ts";
export type {
	AccountDeletionReceipt,
	AuthorshipStanding,
	Contribution,
	Profile,
	PromotionReceipt,
	User,
} from "../pasaport/views.ts";
export {
	accountDeletionReceiptDataView,
	authorshipStandingDataView,
	contributionDataView,
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
