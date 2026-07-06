/**
 * bildirim fate sources — every bildirim entity is delivered inline
 * (`Notification` by the `bildirim.list` resolver, `NotificationUnread` by the
 * `bildirim.unreadCount` query, `NotificationMarkReceipt` by the mark mutations,
 * `NotificationChannel` by the `bildirim.channel` query + reconciled live over
 * `/fate/live`) and never read by id, so all are capability-less
 * `Fate.syntheticSource` entries — view-reachable, no fetch path (the `ReportReceipt`
 * escape hatch, `.patterns/fate-effect-sources.md`).
 *
 * `NotificationChannel` stays loader-less on purpose: its id IS the recipient's user
 * id, so a `byId(userId)` loader would be a cross-user read path bypassing the
 * recipient-scoped `/fate/live` gate. The client must therefore NEVER issue a `byId`
 * for it — it seeds the ref from the `bildirim.channel` query and subscribes live
 * (`useBildirimUnread`, `BildirimList`); an ungated `readView` on a cache miss fetches a
 * `byId` that 500s through the capability-less arm (#2206).
 */
import {Fate} from "@kampus/fate-effect";
import {
	NotificationChannelView,
	NotificationMarkReceiptView,
	NotificationUnreadView,
	NotificationView,
} from "./views.ts";

export const notificationSource = Fate.syntheticSource(NotificationView);
export const notificationUnreadSource = Fate.syntheticSource(NotificationUnreadView);
export const notificationMarkReceiptSource = Fate.syntheticSource(NotificationMarkReceiptView);
export const notificationChannelSource = Fate.syntheticSource(NotificationChannelView);
