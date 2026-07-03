/**
 * bildirim fate sources — every bildirim entity is delivered inline
 * (`Notification` by the `bildirim.list` resolver, `NotificationUnread` by the
 * `bildirim.unreadCount` query, `NotificationMarkReceipt` by the mark mutations)
 * and never read by id, so all are capability-less `Fate.syntheticSource`
 * entries — view-reachable, no fetch path (the `ReportReceipt` escape hatch,
 * `.patterns/fate-effect-sources.md`).
 */
import {Fate} from "@kampus/fate-effect";
import {NotificationMarkReceiptView, NotificationUnreadView, NotificationView} from "./views.ts";

export const notificationSource = Fate.syntheticSource(NotificationView);
export const notificationUnreadSource = Fate.syntheticSource(NotificationUnreadView);
export const notificationMarkReceiptSource = Fate.syntheticSource(NotificationMarkReceiptView);
