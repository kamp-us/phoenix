/**
 * bildirim wire-entity shapers — the one spelling of each `{__typename, …}`
 * literal (the report-shaper idiom): every bildirim entity is returned inline
 * (list resolver / mutation ack), so the interpreter never stamps `__typename`;
 * these do. See `.patterns/fate-effect-operations.md`.
 */
import type {NotificationRow} from "./Notification.ts";
import type {
	Notification,
	NotificationChannel,
	NotificationMarkReceipt,
	NotificationUnread,
} from "./views.ts";

export const toNotification = (row: NotificationRow, targetUrl: string | null): Notification => ({
	__typename: "Notification",
	id: row.id,
	kind: row.kind,
	targetKind: row.targetKind,
	targetId: row.targetId,
	targetUrl,
	actorId: row.actorId,
	count: row.count,
	readAt: row.readAt ? row.readAt.toISOString() : null,
	createdAt: row.createdAt.toISOString(),
});

export const UNREAD_SINGLETON_ID = "unread";

/** The `bildirim.markAllRead` receipt's synthetic id (no single row to name). */
export const MARK_ALL_RECEIPT_ID = "all";

export const toNotificationUnread = (count: number): NotificationUnread => ({
	__typename: "NotificationUnread",
	id: UNREAD_SINGLETON_ID,
	count,
});

export const toNotificationChannel = (
	recipientId: string,
	unreadCount: number,
): NotificationChannel => ({
	__typename: "NotificationChannel",
	id: recipientId,
	unreadCount,
});

export const toMarkReceipt = (
	id: string,
	marked: number,
	unreadCount: number,
): NotificationMarkReceipt => ({
	__typename: "NotificationMarkReceipt",
	id,
	marked,
	unreadCount,
});
