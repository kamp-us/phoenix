/**
 * bildirim data views (#1694). `Notification` is delivered inline by the
 * `bildirim.list` resolver (which stamps `targetUrl` — the server-resolved
 * client link, `null` = tombstone); `NotificationUnread` is a synthetic
 * singleton (`id: "unread"`, the `FunnelSummary` idiom); `NotificationMarkReceipt`
 * is the mark-read ack carrying the fresh unread count so the badge updates on
 * the same round-trip. None is read by id. See `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {NotificationTargetKind} from "./target.ts";

export type NotificationViewRow = ViewRow<{
	id: string;
	kind: string;
	targetKind: NotificationTargetKind;
	targetId: string;
	/** Server-resolved client link; `null` ⇒ the target is gone (tombstone row). */
	targetUrl: string | null;
	actorId: string | null;
	/** Aggregate count (#1698); 1 for a plain notification. */
	count: number;
	/** ISO stamp when read, `null` while unread. */
	readAt: string | null;
	createdAt: string;
}>;

export class NotificationView extends FateDataView<NotificationViewRow>()("Notification")({
	id: true,
	kind: true,
	targetKind: true,
	targetId: true,
	targetUrl: true,
	actorId: true,
	count: true,
	readAt: true,
	createdAt: true,
} satisfies {[K in keyof NotificationViewRow]: true}) {}

export const notificationDataView = NotificationView.view;

export type Notification = WorkerEntity<typeof NotificationView>;

export type NotificationUnreadViewRow = ViewRow<{
	id: string;
	count: number;
}>;

export class NotificationUnreadView extends FateDataView<NotificationUnreadViewRow>()(
	"NotificationUnread",
)({
	id: true,
	count: true,
} satisfies {[K in keyof NotificationUnreadViewRow]: true}) {}

export const notificationUnreadDataView = NotificationUnreadView.view;

export type NotificationUnread = WorkerEntity<typeof NotificationUnreadView>;

export type NotificationMarkReceiptViewRow = ViewRow<{
	/** The marked notification's id, or `"all"` for `bildirim.markAllRead`. */
	id: string;
	/** How many rows flipped unread→read (0 = idempotent no-op). */
	marked: number;
	/** The recipient's unread count AFTER the write. */
	unreadCount: number;
}>;

export class NotificationMarkReceiptView extends FateDataView<NotificationMarkReceiptViewRow>()(
	"NotificationMarkReceipt",
)({
	id: true,
	marked: true,
	unreadCount: true,
} satisfies {[K in keyof NotificationMarkReceiptViewRow]: true}) {}

export const notificationMarkReceiptDataView = NotificationMarkReceiptView.view;

export type NotificationMarkReceipt = WorkerEntity<typeof NotificationMarkReceiptView>;
