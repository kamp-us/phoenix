/**
 * Every bildirim entity is delivered inline by a resolver and never read by id, so
 * all of them are capability-less synthetic sources: view-reachable, with no fetch
 * path (see .patterns/fate-effect-sources.md).
 *
 * `NotificationChannel` stays loader-less on purpose: its id IS the recipient's user
 * id, so a `byId(userId)` loader would be a cross-user read path around the
 * recipient-scoped live gate. The client must therefore never issue a `byId` for it —
 * an ungated `readView` on a cache miss fetches one and 500s (#2206).
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
